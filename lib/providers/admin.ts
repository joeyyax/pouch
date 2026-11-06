/** Admin writes to providers. */
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, organizations, providers } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { ApiError } from "@/lib/api/errors";
import { configureEvents } from "@/lib/domains";
import { recordProviderProbe } from "@/lib/health/checks";
import { newId } from "@/lib/ids";
import { capabilitiesOf, isConfiguredFor } from "@/lib/providers/adapters";
import type { AdapterHealth } from "@/lib/providers/adapters/types";
import type { CreateAdminProviderRequest, PatchAdminProviderRequest } from "@/lib/schemas/admin";
import type { PatchProviderRequest } from "@/lib/schemas/provider";
import { releaseOrganizationSuspension, suspendOrganization } from "@/lib/suspension";
import { assignProvider, createSingleOrgProvider, setDefaultProvider, unassignProvider } from "./assignment";
import {
  loadProvider,
  assertNameAvailable,
  assertUnscoped,
  organizationOf,
  encryptCredentials,
  isUniqueViolation,
  nameConflictError,
  adapterFor,
  validateCredentials,
  validateSettings,
  verifyOrThrow,
  type ProviderCaller,
  type ProviderRow,
} from "./index";
import { serializeProvider, type ProviderWriteFields, type SerializedProvider } from "./serialize";
import { readDefaultProviderId } from "@/lib/settings/service";
import { setDefaultForNewOrganizations, sharedProvider } from "./shared";

function assertNotManaged(provider: ProviderRow, action: string): void {
  if (provider.sharedProviderId) {
    throw new ApiError("validation_failed", `Provider ${provider.name} is an assignment on a shared provider and can't ${action} on its own.`);
  }
}

/**
 * Updates a provider. A credential change is checked live before it's stored, the same
 * as create — a rotation can't leave the provider holding keys that fail on the next send, and a
 * rejected check leaves the previously stored credentials untouched. Settings are merged, not
 * replaced: they can carry state the provider's own setup wrote (an SNS topic ARN, a
 * configuration set name), and a caller changing one shouldn't have to resend the rest.
 */
export async function updateProvider(
  caller: ProviderCaller,
  id: string,
  patch: PatchProviderRequest,
): Promise<SerializedProvider & Partial<ProviderWriteFields>> {
  assertUnscoped(caller, "update a provider");
  const provider = await loadProvider(caller, id);
  assertNotManaged(provider, "be changed");

  const set: Record<string, unknown> = {};
  let verified: AdapterHealth["ok"] | undefined;

  if (patch.credentials) {
    const credentials = validateCredentials(provider.adapter, patch.credentials);
    verified = await verifyOrThrow(provider.adapter, credentials, provider.settings, provider.id);
    set.credentials = encryptCredentials(credentials);
  }
  if (patch.settings) {
    const settings = validateSettings(provider.adapter, patch.settings, { partial: true });
    set.settings = sql`${providers.settings} || ${JSON.stringify(settings)}::jsonb`;
  }
  if (patch.name !== undefined) {
    await assertNameAvailable(caller.organizationId, patch.name, provider.id);
    set.name = patch.name;
  }
  if (patch.concurrency !== undefined) set.concurrency = patch.concurrency;

  let row: ProviderRow | undefined;
  try {
    [row] = await db
      .update(providers)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(providers.id, provider.id))
      .returning();
  } catch (err) {
    if (patch.name !== undefined && isUniqueViolation(err)) throw nameConflictError(patch.name);
    throw err;
  }
  if (!row) throw new ApiError("provider_unavailable", "The provider couldn't be updated.");

  if (patch.credentials) {
    await recordActivity({
      organizationId: caller.organizationId,
      action: "provider.credentials.replaced",
      actor: caller.actor,
      appliesTo: row.id,
      subjectLabel: row.name,
      metadata: { verified },
    });
  }
  if (patch.settings || patch.name !== undefined || patch.concurrency !== undefined) {
    await recordActivity({
      organizationId: caller.organizationId,
      action: "provider.settings.changed",
      actor: caller.actor,
      appliesTo: row.id,
      subjectLabel: row.name,
    });
  }

  const serialized = serializeProvider(row);
  // Present only when this call actually checked credentials — absent, not null, otherwise:
  // null is reserved for "checked and unverifiable," and a settings-only patch never checked.
  return patch.credentials ? { ...serialized, credentials_verified: verified } : serialized;
}

/** Drops the provider. Refuses one with domains still bound to it. */
export async function deleteProvider(caller: ProviderCaller, id: string): Promise<{ id: string; deleted: true }> {
  assertUnscoped(caller, "delete a provider");
  const provider = await loadProvider(caller, id);
  assertNotManaged(provider, "be deleted");

  const bound = await db.select({ name: domains.name }).from(domains).where(eq(domains.providerId, provider.id));
  if (bound.length > 0) {
    const names = bound.map((domain) => domain.name);
    const shown = names.slice(0, 5);
    const rest = names.length - shown.length;
    const list = rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
    throw new ApiError(
      "provider_in_use",
      `Provider ${provider.name} has domains bound to it and can't be deleted: ${list}.`,
      { detail: { domains: names } },
    );
  }

  await db.delete(providers).where(eq(providers.id, provider.id));

  await recordActivity({
    organizationId: caller.organizationId,
    action: "provider.deleted",
    actor: caller.actor,
    appliesTo: provider.id,
    subjectLabel: provider.name,
  });

  return { id: provider.id, deleted: true };
}

export interface CreateSharedProviderInput {
  adapter: string;
  name: string;
  credentials: Record<string, string>;
}

/** Stores a shared provider after a live credential check, then builds its status plumbing. */
export async function createSharedProvider(
  input: CreateSharedProviderInput,
  actor: ActivityActor,
): Promise<{ provider: ProviderRow; configured: boolean; verified: AdapterHealth["ok"] }> {
  if (!capabilitiesOf(input.adapter).sharing) {
    throw new ApiError("validation_failed", `Provider adapter "${input.adapter}" can't be shared across organizations.`, {
      field: "adapter",
    });
  }
  const credentials = validateCredentials(input.adapter, input.credentials);
  await assertNameAvailable(null, input.name);

  const id = newId("provider");
  const settings = { sharing: "operator" };
  const verified = await verifyOrThrow(input.adapter, credentials, settings, id);

  const [provider] = await db
    .insert(providers)
    .values({
      id,
      adapter: input.adapter,
      name: input.name,
      credentials: encryptCredentials(credentials),
      settings,
      shared: true,
    })
    .returning();
  if (!provider) throw new ApiError("provider_unavailable", "The shared provider couldn't be stored.");

  await recordActivity({
    organizationId: null,
    action: "provider.created",
    actor,
    appliesTo: provider.id,
    subjectLabel: provider.name,
    metadata: { adapter: provider.adapter, verified, shared: true },
  });

  return { provider, verified, configured: await configureEvents(provider, "") };
}

/** Re-runs the shared provider's setup. Every step is idempotent. */
export async function configureSharedProvider(id: string): Promise<boolean> {
  return configureEvents(await sharedProvider(id), "");
}

/** Replaces the credentials on the shared provider and every assignment row that copies them, in one statement. */
export async function rotateSharedCredentials(id: string, input: Record<string, string>, actor: ActivityActor): Promise<AdapterHealth["ok"]> {
  const provider = await sharedProvider(id);
  const credentials = validateCredentials(provider.adapter, input);
  const verified = await verifyOrThrow(provider.adapter, credentials, provider.settings, provider.id);

  await db
    .update(providers)
    .set({ credentials: encryptCredentials(credentials), updatedAt: new Date() })
    .where(or(eq(providers.id, provider.id), eq(providers.sharedProviderId, provider.id)));

  await recordActivity({
    organizationId: provider.organizationId,
    action: "provider.credentials.replaced",
    actor,
    appliesTo: provider.id,
    subjectLabel: provider.name,
    metadata: { verified, shared: true },
  });
  return verified;
}

/** Renames a shared provider. Assignment rows keep their own names. */
export async function renameSharedProvider(id: string, name: string, actor: ActivityActor): Promise<void> {
  const provider = await sharedProvider(id);
  await assertNameAvailable(provider.organizationId, name, provider.id);
  try {
    await db.update(providers).set({ name, updatedAt: new Date() }).where(eq(providers.id, provider.id));
  } catch (err) {
    if (isUniqueViolation(err)) throw nameConflictError(name);
    throw err;
  }
  await recordActivity({
    organizationId: provider.organizationId,
    action: "provider.settings.changed",
    actor,
    appliesTo: provider.id,
    subjectLabel: name,
  });
}

/**
 * Runs the adapter's health check on demand and records the verdict as a probe. Never mutates
 * the provider, but a deliberate test is the same evidence a scheduled probe is, and dropping it
 * left the screen saying "not checked" straight after someone checked.
 */
export async function probeProvider(provider: ProviderRow): Promise<AdapterHealth> {
  const health = await adapterFor(provider).healthCheck();
  await recordProviderProbe(provider.id, provider.adapter, health);
  return health;
}

/** Drops a shared provider. Refused while any organization is assigned to it. */
export async function deleteSharedProvider(id: string, actor: ActivityActor): Promise<{ id: string; deleted: true }> {
  const provider = await sharedProvider(id);
  const assigned = await db
    .select({ organizationId: providers.organizationId })
    .from(providers)
    .where(eq(providers.sharedProviderId, provider.id));
  if (assigned.length > 0) {
    throw new ApiError(
      "provider_in_use",
      `${assigned.length} ${assigned.length === 1 ? "organization is" : "organizations are"} assigned to ${provider.name}. Unassign ${assigned.length === 1 ? "it" : "them"} first.`,
      { detail: { organizations: assigned.map((row) => row.organizationId) } },
    );
  }
  try {
    await db.delete(providers).where(eq(providers.id, provider.id));
  } catch (err) {
    // An organization assigned since the check holds the foreign key.
    if ((err as { cause?: { code?: string } }).cause?.code === "23503") {
      throw new ApiError("provider_in_use", `An organization was assigned to ${provider.name} while deleting. Unassign it first.`);
    }
    throw err;
  }
  await recordActivity({
    organizationId: provider.organizationId,
    action: "provider.deleted",
    actor,
    appliesTo: provider.id,
    subjectLabel: provider.name,
  });
  return { id: provider.id, deleted: true };
}

// Admin API (`/v1/admin/*`). Each write also lands on the service's own activity.

export interface AdminWriteContext {
  actor: ActivityActor;
}

/** Mirrors an admin write that touched an organization onto the service's own activity. */
async function mirrorToService(entry: Parameters<typeof recordActivity>[0]): Promise<void> {
  if (entry.organizationId === null) return;
  await recordActivity({
    ...entry,
    organizationId: null,
    metadata: { ...(entry.metadata ?? {}), organizationId: entry.organizationId },
  });
}

function refuse(field: string, message: string): ApiError {
  return new ApiError("validation_failed", message, { field });
}

/** Creates a shared provider for a shareable adapter, or a single-organization provider otherwise. */
export async function createAdminProvider(
  request: CreateAdminProviderRequest,
  { actor }: AdminWriteContext,
): Promise<{ provider: ProviderRow; verified: AdapterHealth["ok"]; configured: boolean }> {
  if (capabilitiesOf(request.adapter).sharing) {
    if (request.organization_id) {
      throw refuse("organization_id", `Provider adapter "${request.adapter}" serves every organization. Create it, then assign organizations.`);
    }
    if (request.settings && Object.keys(request.settings).length > 0) {
      throw refuse("settings", "A shareable provider's settings are written by its setup.");
    }
    const created = await createSharedProvider({ adapter: request.adapter, name: request.name, credentials: request.credentials }, actor);
    if (request.concurrency !== undefined) {
      await db.update(providers).set({ concurrency: request.concurrency }).where(eq(providers.id, created.provider.id));
    }
    return created;
  }

  if (!request.organization_id) {
    throw refuse("organization_id", `Provider adapter "${request.adapter}" serves one organization. Name it with organization_id.`);
  }
  const { provider, verified } = await createSingleOrgProvider(
    { adapter: request.adapter, name: request.name, credentials: request.credentials, settings: request.settings, concurrency: request.concurrency },
    request.organization_id,
    actor,
  );
  await mirrorToService({
    organizationId: provider.organizationId,
    action: "provider.created",
    actor,
    appliesTo: provider.id,
    subjectLabel: provider.name,
    metadata: { adapter: provider.adapter, verified },
  });
  return { provider, verified, configured: isConfiguredFor(provider.adapter, provider.settings) };
}

async function updateSharedProvider(provider: ProviderRow, patch: PatchAdminProviderRequest, actor: ActivityActor): Promise<AdapterHealth["ok"] | undefined> {
  if (patch.settings) throw refuse("settings", "A shareable provider's settings are written by its setup.");

  const verified = patch.credentials ? await rotateSharedCredentials(provider.id, patch.credentials, actor) : undefined;

  if (patch.name !== undefined) await renameSharedProvider(provider.id, patch.name, actor);
  // Assignment rows copy the parent's concurrency when they're created.
  if (patch.concurrency !== undefined) {
    await db
      .update(providers)
      .set({ concurrency: patch.concurrency, updatedAt: new Date() })
      .where(or(eq(providers.id, provider.id), eq(providers.sharedProviderId, provider.id)));
  }
  // False only clears the pointer when it names this provider; it never unsets another's.
  if (patch.default_for_new_organizations === true) await setDefaultForNewOrganizations(provider.id);
  else if (patch.default_for_new_organizations === false && (await readDefaultProviderId()) === provider.id) {
    await setDefaultForNewOrganizations(null);
  }

  if (patch.concurrency !== undefined || patch.default_for_new_organizations !== undefined) {
    await recordActivity({
      organizationId: provider.organizationId,
      action: "provider.settings.changed",
      actor,
      appliesTo: provider.id,
      subjectLabel: patch.name ?? provider.name,
      metadata: {
        ...(patch.concurrency !== undefined ? { concurrency: patch.concurrency } : {}),
        ...(patch.default_for_new_organizations !== undefined ? { defaultForNewOrganizations: patch.default_for_new_organizations } : {}),
      },
    });
  }
  return verified;
}

/** Updates an admin provider. Returns the credential check's verdict when credentials changed. */
export async function updateAdminProvider(
  provider: ProviderRow,
  patch: PatchAdminProviderRequest,
  { actor }: AdminWriteContext,
): Promise<{ verified?: AdapterHealth["ok"] }> {
  if (provider.shared) return { verified: await updateSharedProvider(provider, patch, actor) };

  if (patch.default_for_new_organizations) {
    throw refuse("default_for_new_organizations", `Provider ${provider.name} serves one organization, so it can't be the default for new ones.`);
  }
  const { default_for_new_organizations: _ignored, ...rest } = patch;
  if (Object.values(rest).every((value) => value === undefined)) return {};

  const caller = { organizationId: organizationOf(provider), domainIds: [], actor };
  const updated = await updateProvider(caller, provider.id, rest);
  await mirrorToService({
    organizationId: caller.organizationId,
    action: rest.credentials ? "provider.credentials.replaced" : "provider.settings.changed",
    actor,
    appliesTo: provider.id,
    subjectLabel: updated.name,
  });
  return "credentials_verified" in updated ? { verified: updated.credentials_verified } : {};
}

/** Deletes an admin provider. A shared one is refused while any organization is assigned to it. */
export async function deleteAdminProvider(provider: ProviderRow, { actor }: AdminWriteContext): Promise<{ id: string; deleted: true }> {
  if (!provider.shared) {
    const organizationId = organizationOf(provider);
    const result = await deleteProvider({ organizationId, domainIds: [], actor }, provider.id);
    await mirrorToService({ organizationId, action: "provider.deleted", actor, appliesTo: provider.id, subjectLabel: provider.name });
    return result;
  }

  return deleteSharedProvider(provider.id, actor);
}

/** Runs the provider's setup again. Every step is idempotent. */
export async function setupAdminProvider(provider: ProviderRow): Promise<boolean> {
  return provider.shared ? configureSharedProvider(provider.id) : configureEvents(provider, "");
}

export async function assignOrganization(
  providerId: string,
  organizationId: string,
  options: { default?: boolean },
  { actor }: AdminWriteContext,
): Promise<ProviderRow> {
  const assignment = await assignProvider(providerId, organizationId, actor, { default: options.default });
  await mirrorToService({
    organizationId,
    action: "provider.shared.attached",
    actor,
    appliesTo: assignment.id,
    subjectLabel: assignment.name,
    metadata: { sharedProviderId: providerId },
  });
  return assignment;
}

export async function unassignOrganization(provider: ProviderRow, organizationId: string, { actor }: AdminWriteContext): Promise<void> {
  const [tenant] = provider.shared
    ? await db
        .select({ id: providers.id, name: providers.name })
        .from(providers)
        .where(and(eq(providers.sharedProviderId, provider.id), eq(providers.organizationId, organizationId)))
        .limit(1)
    : [];
  if (provider.shared && !tenant) {
    throw new ApiError("not_found", `Organization ${organizationId} isn't assigned provider ${provider.name}.`, { field: "organization_id" });
  }
  await unassignProvider(provider.id, organizationId, actor);
  await mirrorToService({
    organizationId,
    action: "provider.shared.detached",
    actor,
    appliesTo: tenant!.id,
    subjectLabel: tenant!.name,
    metadata: { sharedProviderId: provider.id },
  });
}

export async function setOrganizationDefault(organizationId: string, assignmentId: string, { actor }: AdminWriteContext): Promise<void> {
  await setDefaultProvider(organizationId, assignmentId, actor);
  await mirrorToService({ organizationId, action: "provider.default.changed", actor, appliesTo: assignmentId });
}

/**
 * One organization's active addresses and messages per address per day, over the install's
 * defaults. Null goes back to the default. Lowering either leaves existing addresses alone.
 */
export async function setAddressLimits(
  organizationId: string,
  limits: { addressLimit?: number | null; addressDailyMessageLimit?: number | null },
  { actor }: AdminWriteContext,
): Promise<void> {
  if (limits.addressLimit === undefined && limits.addressDailyMessageLimit === undefined) return;
  assertAddressLimit("address_limit", limits.addressLimit);
  assertAddressLimit("address_daily_message_limit", limits.addressDailyMessageLimit);
  const [before] = await db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!before) throw new ApiError("not_found", `No organization with id ${organizationId}.`, { field: "id" });
  const unchanged =
    (limits.addressLimit === undefined || limits.addressLimit === before.addressLimit) &&
    (limits.addressDailyMessageLimit === undefined || limits.addressDailyMessageLimit === before.addressDailyMessageLimit);
  if (unchanged) return;
  const [row] = await db
    .update(organizations)
    .set({ ...limits, updatedAt: await dbNow() })
    .where(eq(organizations.id, organizationId))
    .returning();
  const metadata = {
    from: { addressLimit: before.addressLimit, addressDailyMessageLimit: before.addressDailyMessageLimit },
    to: { addressLimit: row!.addressLimit, addressDailyMessageLimit: row!.addressDailyMessageLimit },
  };
  await recordActivity({ organizationId, action: "settings.address_limits.changed", actor, metadata });
  await mirrorToService({ organizationId, action: "settings.address_limits.changed", actor, metadata });
}

/** Most an admin can set either address limit to. */
export const ADDRESS_LIMIT_MAX = 1_000_000;

function assertAddressLimit(field: string, value: number | null | undefined): void {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || value < 0 || value > ADDRESS_LIMIT_MAX) {
    throw new ApiError("validation_failed", `Field "${field}" is a whole number from 0 to ${ADDRESS_LIMIT_MAX}, or empty for the install's default.`, { field });
  }
}

/** A manual suspension, which fails the organization's queued mail. */
export async function suspendOrganizationManually(organizationId: string, reason: string, { actor }: AdminWriteContext): Promise<boolean> {
  const wrote = await suspendOrganization(organizationId, { source: "manual", reason }, actor);
  if (wrote) {
    await mirrorToService({ organizationId, action: "organization.suspended", actor, appliesTo: organizationId, metadata: { source: "manual", reason } });
  }
  return wrote;
}

export async function releaseOrganization(organizationId: string, { actor }: AdminWriteContext): Promise<boolean> {
  const released = await releaseOrganizationSuspension(organizationId, actor);
  if (released) await mirrorToService({ organizationId, action: "organization.suspension.released", actor, appliesTo: organizationId });
  return released;
}
