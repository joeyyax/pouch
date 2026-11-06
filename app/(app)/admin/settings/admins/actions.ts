"use server";

import { revalidatePath } from "next/cache";
import { adminActor } from "@/lib/activity/record";
import { requireAdmin } from "@/lib/auth/admin";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import { findUserByEmail, UnknownEmailError } from "@/lib/dashboard/admins";
import { deleteOperatorAccount, setOperatorAdmin } from "@/lib/operators";

const PATH = "/admin/settings/admins";

function actorFor(session: Awaited<ReturnType<typeof requireAdmin>>) {
  return adminActor(session.user.id, session.user.name ?? session.user.email ?? "Admin");
}

export async function promoteAdminAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const email = String(form.get("email") ?? "").trim();
  if (!email) return { status: "error", message: 'Field "email" is required.', field: "email" };

  try {
    const account = await findUserByEmail(email);
    if (!account) throw new UnknownEmailError(email);
    await setOperatorAdmin(account.id, true, actorFor(session));
    revalidatePath(PATH);
    return succeeded(`${account.name} is now an admin.`);
  } catch (error) {
    if (error instanceof UnknownEmailError) return { status: "error", message: error.message, field: "email" };
    return failed(error, "The account couldn't be promoted.");
  }
}

export async function demoteAdminAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const id = String(form.get("id") ?? "");

  try {
    await setOperatorAdmin(id, false, actorFor(session));
    revalidatePath(PATH);
    return succeeded("Admin access removed.");
  } catch (error) {
    return failed(error, "Admin access couldn't be removed.");
  }
}

export async function deleteAccountAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const id = String(form.get("id") ?? "");

  try {
    const { email } = await deleteOperatorAccount(id, actorFor(session));
    revalidatePath(PATH);
    return succeeded(`Account ${email} deleted.`);
  } catch (error) {
    return failed(error, "The account couldn't be deleted.");
  }
}
