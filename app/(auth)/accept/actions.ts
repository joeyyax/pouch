"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { getSession } from "@/lib/auth/session";
import { enabledSignInMethods } from "@/lib/auth/sign-in-methods";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import { setActiveOrganization } from "@/lib/dashboard/session";
import { acceptInvitationAs, previewInvitation, redeemInvitation } from "@/lib/invitations";

const GONE = "This invitation is no longer valid. Ask an owner to send a new one.";

/** Minimum Better Auth accepts. */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Creates the account the invitation names, signs it in and lands it in the organization. While
 * password sign-in is off the account gets no password; the form offers a passkey next.
 */
export async function acceptInvitationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = String(form.get("token") ?? "");
  const name = String(form.get("name") ?? "").trim();
  const withPassword = (await enabledSignInMethods()).password;
  const password = withPassword ? String(form.get("password") ?? "") : null;

  if (password !== null && password.length < MIN_PASSWORD_LENGTH) {
    return { status: "error", message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`, field: "password" };
  }
  if (password !== null && password !== String(form.get("confirm") ?? "")) {
    return { status: "error", message: "The passwords don't match.", field: "confirm" };
  }

  const invitation = await previewInvitation(token);
  if (invitation.state !== "open") return { status: "error", message: GONE };

  try {
    const result = await redeemInvitation(token, name, password);
    if (!result) return { status: "error", message: GONE };

    if (password === null) await auth.api.signInInvitedAccount({ body: { userId: result.userId } });
    else await auth.api.signInEmail({ body: { email: invitation.email, password } });
    await setActiveOrganization(result.organizationId);
    revalidatePath("/", "layout");
    return succeeded(`Welcome to ${invitation.organizationName}.`);
  } catch (error) {
    return failed(error, "The invitation couldn't be accepted.");
  }
}

/** Adds the signed-in account to the organization the invitation names. */
export async function joinOrganizationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = String(form.get("token") ?? "");
  const session = await getSession();
  if (!session?.user?.id) return { status: "error", message: "Sign in first, then open the link again." };

  try {
    const result = await acceptInvitationAs(token, { id: session.user.id, email: session.user.email });
    if (!result) return { status: "error", message: GONE };

    await setActiveOrganization(result.organizationId);
    revalidatePath("/", "layout");
    return succeeded("You're in.");
  } catch (error) {
    return failed(error, "The invitation couldn't be accepted.");
  }
}
