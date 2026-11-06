"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { requireOrganizationOwner, sessionActor } from "@/lib/dashboard/session";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import { featureAction } from "@/lib/dashboard/feature-action";
import { ROLES } from "@/lib/auth/permissions";
import { inviteToOrganization, resendInvitation, revokeInvitation } from "@/lib/invitations";
import { removeMember, updateMemberRole } from "@/lib/memberships";
import { retentionCeiling, updateOrganization } from "@/lib/organizations";
import { deleteOrganization } from "@/lib/organizations/delete";
import { muteObservation, observationTitle, setObservationOn, unmuteObservation, type ObservationCaller } from "@/lib/observations/_mutes";
import { setDmarcReportsEnabled } from "@/lib/dmarc/switch";
import { createInvitationSchema } from "@/lib/schemas/invitation";
import { updateOrganizationSettingsSchema } from "@/lib/schemas/organization-settings";

function zodError(error: unknown, fallback: string): ActionState {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return {
      status: "error",
      message: issue ? `Field "${issue.path.join(".") || "value"}" isn't valid: ${issue.message}.` : fallback,
      ...(issue?.path[0] ? { field: String(issue.path[0]) } : {}),
    };
  }
  return failed(error, fallback);
}

/**
 * Name and body retention are organization-wide, not sending work: retention changes how long
 * every body stays readable. Owner-only.
 */
export async function updateOrganizationSettingsAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationOwner("change organization settings");
  const name = form.get("name");
  if (name !== null && !String(name).trim()) return { status: "error", message: "Name the organization.", field: "name" };
  const days = Number(form.get("bodyRetentionDays"));
  const ceiling = await retentionCeiling();
  if (!Number.isInteger(days) || days < 7 || days > ceiling) {
    return { status: "error", message: `Body retention is a whole number of days, 7 to ${ceiling}.`, field: "body_retention_days" };
  }

  try {
    const patch = updateOrganizationSettingsSchema.parse({
      ...(name === null ? {} : { name }),
      body_retention_days: form.get("bodyRetentionDays"),
    });
    await updateOrganization(
      { organizationId: session.organizationId, domainIds: [], actor: sessionActor(session) },
      patch,
    );
    revalidatePath("/settings/general");
    return succeeded("Organization settings updated.");
  } catch (error) {
    return zodError(error, "The organization settings couldn't be updated.");
  }
}

/** People are owner work — see docs/decisions.md, "Admin is service-wide; an organization has owners and members". */
export async function updateMemberRoleAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationOwner("change someone's role");
  const userId = String(form.get("userId") ?? "");
  const role = String(form.get("role") ?? "");
  if (role !== ROLES.OWNER && role !== ROLES.MEMBER) {
    return { status: "error", message: `Field "role" isn't valid.`, field: "role" };
  }

  try {
    const member = await updateMemberRole(session.organizationId, userId, role, sessionActor(session));
    revalidatePath("/settings/members");
    return succeeded(`${member.name} is now ${role === ROLES.OWNER ? "an owner" : "a member"}.`);
  } catch (error) {
    return failed(error, "The role couldn't be changed.");
  }
}

/**
 * Mails an invitation. Owner work, the same line every other people change sits on.
 */
export async function inviteMemberAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationOwner("invite someone to this organization");

  try {
    const input = createInvitationSchema.parse({ email: form.get("email"), role: form.get("role") ?? undefined });
    const invitation = await inviteToOrganization(session.organizationId, input, {
      userId: session.userId,
      name: session.name,
      actor: sessionActor(session),
    });
    revalidatePath("/settings/members");
    return succeeded(`Invitation sent to ${invitation.email}.`);
  } catch (error) {
    return zodError(error, "The invitation couldn't be sent.");
  }
}

/** Kills the link. The address can be invited again afterwards. */
export async function revokeInvitationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationOwner("revoke an invitation");
  const id = String(form.get("invitationId") ?? "");

  try {
    const invitation = await revokeInvitation(session.organizationId, id, sessionActor(session));
    revalidatePath("/settings/members");
    return succeeded(`Invitation to ${invitation.email} revoked.`);
  } catch (error) {
    return failed(error, "The invitation couldn't be revoked.");
  }
}

/** Mails a new token and resets the 7-day window. The previous link stops working. */
export async function resendInvitationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationOwner("resend an invitation");
  const id = String(form.get("invitationId") ?? "");

  try {
    const invitation = await resendInvitation(session.organizationId, id, {
      name: session.name,
      actor: sessionActor(session),
    });
    revalidatePath("/settings/members");
    return succeeded(`Invitation resent to ${invitation.email}.`);
  } catch (error) {
    return failed(error, "The invitation couldn't be resent.");
  }
}

/**
 * Removing someone leaves the keys they created alone. An organization key carries the
 * organization's authority, not a person's — see docs/decisions.md.
 */
export async function removeMemberAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationOwner("remove someone from this organization");
  const userId = String(form.get("userId") ?? "");

  try {
    await removeMember(session.organizationId, userId, sessionActor(session));
    revalidatePath("/settings/members");
    return succeeded("Removed from the organization.");
  } catch (error) {
    return failed(error, "They couldn't be removed.");
  }
}

/**
 * The organization, its domains at the provider, its keys, people and send history. Owner-only,
 * and scoped to the organization the session is already in — an id from the form can't widen it.
 */
export async function deleteOrganizationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationOwner("delete this organization");
  if (String(form.get("id") ?? "") !== session.organizationId) {
    return { status: "error", message: "That isn't the organization you're in." };
  }

  try {
    await deleteOrganization(session.organizationId, sessionActor(session));
  } catch (error) {
    return failed(error, "The organization couldn't be deleted.");
  }

  revalidatePath("/", "layout");
  redirect("/");
}

function observationCaller(session: Awaited<ReturnType<typeof requireOrganizationOwner>>): ObservationCaller {
  return { organizationId: session.organizationId, domainIds: [], actor: sessionActor(session), userId: session.userId };
}

function revalidateObservations(): void {
  revalidatePath("/");
  revalidatePath("/settings/sending");
}

/** Mutes an observation for one tag or one key. Owner work, like every organization setting. */
export const muteObservationAction = featureAction("observations", async function muteObservationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationOwner("mute an observation");
  const key = String(form.get("observation") ?? "");
  const tag = form.get("tag");
  const keyId = form.get("keyId");

  try {
    const scope = await muteObservation(observationCaller(session), key, tag !== null ? { tag: String(tag) } : { keyId: String(keyId ?? "") });
    revalidateObservations();
    return succeeded(`${observationTitle(key)} muted ${scope}.`);
  } catch (error) {
    return failed(error, "The observation couldn't be muted.");
  }
});

export const unmuteObservationAction = featureAction("observations", async function unmuteObservationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationOwner("unmute an observation");

  try {
    await unmuteObservation(observationCaller(session), String(form.get("muteId") ?? ""));
    revalidateObservations();
    return succeeded("Unmuted.");
  } catch (error) {
    return failed(error, "The mute couldn't be removed.");
  }
});

/** Turns DMARC reports on or off for the organization. */
export const setDmarcReportsEnabledAction = featureAction("dmarc_reports", async function setDmarcReportsEnabledAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationOwner("turn DMARC reports on or off");
  const enabled = form.get("enabled") === "true";

  try {
    await setDmarcReportsEnabled({ organizationId: session.organizationId, actor: sessionActor(session) }, enabled);
    revalidatePath("/settings/sending");
    return succeeded(enabled ? "DMARC reports turned on." : "DMARC reports turned off.");
  } catch (error) {
    return failed(error, "DMARC reports couldn't be changed.");
  }
});

/** Turns an observation on or off for the whole organization. */
export const setObservationOnAction = featureAction("observations", async function setObservationOnAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationOwner("turn an observation on or off");
  const key = String(form.get("observation") ?? "");
  const on = form.get("on") === "true";

  try {
    await setObservationOn(observationCaller(session), key, on);
    revalidateObservations();
    return succeeded(`${observationTitle(key)} turned ${on ? "on" : "off"}.`);
  } catch (error) {
    return failed(error, "The observation couldn't be changed.");
  }
});
