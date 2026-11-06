"use server";

import { localPath } from "@/lib/dashboard/local-path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { assignOrganization, releaseOrganization, setAddressLimits, suspendOrganizationManually } from "@/lib/providers/admin";
import { requireAdmin } from "@/lib/auth/admin";
import { adminActor, recordActivity } from "@/lib/activity/record";
import { listReachableOrganizations } from "@/lib/dashboard/session";
import { EMULATION_DURATION_MS, startEmulation } from "@/lib/dashboard/emulation";
import { readOrganization } from "@/lib/organizations";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import { assignedProviderName } from "@/lib/dashboard/admin-organizations";
import { provisionOrganization, SlugTakenError } from "@/lib/organizations";
import { deleteOrganization } from "@/lib/organizations/delete";
import { createOrganizationSchema } from "@/lib/schemas/organization";
import { formatNumber } from "@/lib/format/number";

const MAX_REASON_LENGTH = 500;
const PATH = "/admin/settings/organizations";
const EMULATION_MINUTES = Math.round(EMULATION_DURATION_MS / 60_000);

/** Admin screens act on the service's authority, so their rows say so in someone else's feed. */
function actor(session: Awaited<ReturnType<typeof requireAdmin>>) {
  return adminActor(session.user.id, session.user.name ?? session.user.email ?? "Admin");
}

export async function suspendOrganizationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const id = String(form.get("id") ?? "");
  const reason = String(form.get("reason") ?? "").trim();
  if (!reason) return { status: "error", message: 'Field "reason" is required.', field: "reason" };
  if (reason.length > MAX_REASON_LENGTH) {
    return { status: "error", message: `Keep the reason under ${MAX_REASON_LENGTH} characters.`, field: "reason" };
  }

  try {
    const wrote = await suspendOrganizationManually(id, reason, { actor: actor(session) });
    revalidatePath(PATH);
    return succeeded(wrote ? "Organization suspended." : "Organization was already suspended.");
  } catch (error) {
    return failed(error, "The organization couldn't be suspended.");
  }
}

export async function releaseOrganizationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const id = String(form.get("id") ?? "");

  try {
    await releaseOrganization(id, { actor: actor(session) });
    revalidatePath(PATH);
    return succeeded("Suspension released.");
  } catch (error) {
    return failed(error, "The suspension couldn't be released.");
  }
}

export async function assignProviderAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  try {
    await assignOrganization(
      String(form.get("sharedProviderId") ?? ""),
      String(form.get("id") ?? ""),
      {},
      { actor: actor(session) },
    );
    revalidatePath(PATH);
    revalidatePath("/admin/settings/providers", "layout");
    return succeeded("Provider assigned. The organization's first domain sets up its space at the provider.");
  } catch (error) {
    return failed(error, "The provider couldn't be assigned.");
  }
}

/** A blank field goes back to the install's default. */
function limitField(form: FormData, name: string): number | null {
  const raw = String(form.get(name) ?? "").trim();
  return raw === "" ? null : Number(raw);
}

export async function setAddressLimitsAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const id = String(form.get("id") ?? "");
  try {
    await setAddressLimits(
      id,
      { addressLimit: limitField(form, "addressLimit"), addressDailyMessageLimit: limitField(form, "addressDailyMessageLimit") },
      { actor: actor(session) },
    );
    revalidatePath(PATH);
    return succeeded("Address limits saved.");
  } catch (error) {
    return failed(error, "The address limits couldn't be saved.");
  }
}

/**
 * Deletes the organization, its domains at the provider, and everything else it holds. Admin
 * work here, owner work in the organization's own settings; both call the same capability.
 */
export async function deleteOrganizationAdminAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const id = String(form.get("id") ?? "");

  try {
    const result = await deleteOrganization(id, actor(session));
    revalidatePath(PATH);
    revalidatePath("/", "layout");
    return succeeded(
      `Organization deleted. ${result.domains} ${result.domains === 1 ? "domain" : "domains"} and ${formatNumber(result.messages)} ${result.messages === 1 ? "message" : "messages"} went with it.`,
    );
  } catch (error) {
    return failed(error, "The organization couldn't be deleted.");
  }
}

export type CreateOrganizationState = ActionState | { status: "created"; name: string; providerName: string | null };

/** Creates an organization with the admin as its owner, on the default provider. */
export async function createOrganizationAdminAction(
  _previous: CreateOrganizationState,
  form: FormData,
): Promise<CreateOrganizationState> {
  const session = await requireAdmin();
  try {
    const request = createOrganizationSchema.parse({ name: form.get("name"), slug: form.get("slug") || undefined });
    const organization = await provisionOrganization(
      request,
      session.user.id,
      actor(session),
    );
    const providerName = await assignedProviderName(organization.id);
    revalidatePath(PATH);
    revalidatePath("/", "layout");
    return { status: "created", name: organization.name, providerName };
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      return {
        status: "error",
        message: issue?.message ?? "The organization couldn't be created.",
        ...(issue?.path[0] ? { field: String(issue.path[0]) } : {}),
      };
    }
    if (error instanceof SlugTakenError) return { status: "error", message: error.message, field: "slug" };
    return failed(error, "The organization couldn't be created.");
  }
}

/**
 * Enters an organization the admin holds no membership in. Recorded in that organization's
 * activity, banner-marked while it lasts, and expiring on its own.
 */
export async function startEmulationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const refusal = await enterEmulation(String(form.get("id") ?? ""));
  if (refusal) return refusal;
  // Server-side, so the admin lands in the organization with the banner already on it.
  redirect(localPath(form.get("next")) ?? "/");
}

/** The refusal, or null once the ticket is written. */
async function enterEmulation(id: string): Promise<ActionState | null> {
  const session = await requireAdmin();

  try {
    const organization = await readOrganization(id);
    if (!organization) return { status: "error", message: "That organization no longer exists." };
    const memberships = await listReachableOrganizations(session.user.id);
    if (memberships.some((membership) => membership.id === id)) {
      return { status: "error", message: `You're a member of ${organization.name}. Switch to it from your organizations instead.` };
    }

    const expiresAt = await startEmulation(id);
    await recordActivity({
      organizationId: id,
      action: "session.emulation.started",
      actor: actor(session),
      metadata: { expiresAt: expiresAt.toISOString(), detail: `ends in ${EMULATION_MINUTES} minutes` },
    });
    revalidatePath("/", "layout");
    return null;
  } catch (error) {
    return failed(error, "Emulation couldn't be started.");
  }
}
