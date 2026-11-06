"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { userActor } from "@/lib/activity/record";
import { getSession } from "@/lib/auth/session";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import { organizationCreationRefusal, provisionOrganization, SlugTakenError } from "@/lib/organizations";
import { leaveEmulation } from "@/lib/dashboard/emulation";
import { setActiveOrganization } from "@/lib/dashboard/session";
import { createOrganizationSchema } from "@/lib/schemas/organization";

/**
 * Who may create an organization is the install's `organization_creation` setting; open, the
 * default, is anyone signed in. The creator gets an owner membership on it (`createOrganization`,
 * atomic with the organization row) and lands there immediately: creating an organization and
 * staying in the old one is a papercut.
 */
export async function createOrganizationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session?.user?.id) {
    return { status: "error", message: "You need to be signed in to create an organization." };
  }
  const refused = await organizationCreationRefusal(session.user.id);
  if (refused) return { status: "error", message: refused };

  try {
    const request = createOrganizationSchema.parse({
      name: form.get("name"),
      slug: form.get("slug"),
    });
    const organization = await provisionOrganization(request, session.user.id, userActor(session.user.id, session.user.name || session.user.email));

    // Landing in the new organization is also leaving whichever one was being emulated.
    if ((session.user as { admin?: boolean }).admin) {
      await leaveEmulation({ id: session.user.id, label: session.user.name || session.user.email });
    }
    await setActiveOrganization(organization.id);
    revalidatePath("/", "layout");
    return succeeded(`${organization.name} created.`);
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      return {
        status: "error",
        message: issue?.message ?? "That organization couldn't be created.",
        ...(issue?.path[0] ? { field: String(issue.path[0]) } : {}),
      };
    }
    if (error instanceof SlugTakenError) {
      return { status: "error", message: error.message, field: "slug" };
    }
    return failed(error, "That organization couldn't be created.");
  }
}
