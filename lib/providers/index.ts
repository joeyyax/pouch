import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, organizations, providers } from "@/lib/db/schema";
import { readProviderRecord } from "@/lib/health/checks";
import { decrypt, encrypt } from "@/lib/crypto";
import { buildAdapter, capabilitiesOf, capabilitiesWith, credentialsSchemaOf, hasCredentialCapabilities, settingsSchemaOf } from "@/lib/providers/adapters";
import type { Adapter, AdapterCapabilities, AdapterHealth, ProviderSettings } from "@/lib/providers/adapters/types";
import { ApiError } from "@/lib/api/errors";
import { assignmentSettingUp } from "./status";
import { apiRateSubject } from "./send-rate";
import type { ActivityActor } from "@/lib/activity/types";
import {
  serializeProvider,
  type OrganizationProvider,
  type ProviderStatus,
  type SerializedProvider,
} from "./serialize";
import { keysetBefore } from "@/lib/db/keyset";
import { CredentialsUnreadableError } from "./unreadable";

export type ProviderRow = typeof providers.$inferSelect;

/** A row that belongs to an organization: anything but a shared provider. */
export type OrganizationProviderRow = ProviderRow & { organizationId: string };

/** The row's organization. Only a shared provider has none. */
export function organizationOf(provider: ProviderRow): string {
  if (provider.organizationId === null) {
    throw new ApiError("validation_failed", `Provider ${provider.name} belongs to the service, not to an organization.`);
  }
  return provider.organizationId;
}

const UNIQUE_VIOLATION = "23505";

/** Drizzle wraps driver errors, so the Postgres code sits on the cause. */
export function isUniqueViolation(err: unknown): boolean {
  const candidates = [err, (err as { cause?: unknown }).cause];
  return candidates.some((candidate) => (candidate as { code?: string } | undefined)?.code === UNIQUE_VIOLATION);
}

export function nameConflictError(name: string): ApiError {
  return new ApiError("provider_exists", `A provider named "${name}" already exists.`, { field: "name" });
}

/** Checks the name is free before a write reaches the database. A null organization means among shared providers. */
export async function assertNameAvailable(organizationId: string | null, name: string, excludeId?: string): Promise<void> {
  const [existing] = await db
    .select({ id: providers.id })
    .from(providers)
    .where(
      and(
        organizationId === null ? isNull(providers.organizationId) : eq(providers.organizationId, organizationId),
        eq(providers.name, name),
      ),
    )
    .limit(1);
  if (existing && existing.id !== excludeId) throw nameConflictError(name);
}

export function encryptCredentials(credentials: Record<string, string>): string {
  return encrypt(JSON.stringify(credentials));
}

export function decryptCredentials(provider: Pick<ProviderRow, "name" | "credentials">): Record<string, string> {
  let plaintext: string;
  try {
    plaintext = decrypt(provider.credentials);
  } catch {
    throw new CredentialsUnreadableError(provider.name);
  }
  return JSON.parse(plaintext) as Record<string, string>;
}

/** What this provider's own credentials can do. Decrypts only for an adapter whose capabilities depend on them. */
export function providerCapabilities(provider: Pick<ProviderRow, "adapter" | "name" | "credentials">): AdapterCapabilities {
  if (!hasCredentialCapabilities(provider.adapter)) return capabilitiesOf(provider.adapter);
  return capabilitiesWith(provider.adapter, decryptCredentials(provider));
}

/** Builds the adapter for a provider row, decrypting its credentials. */
export function adapterFor(provider: ProviderRow): Adapter {
  return buildAdapter(provider.adapter, decryptCredentials(provider), provider.settings, provider.id, {
    apiRateSubject: apiRateSubject(provider),
    saveSettings: (patch) => mergeSettings(provider.id, patch),
  });
}

/**
 * Merges keys into a provider's settings in SQL. A read-modify-write from an in-memory row loses
 * whatever another request wrote in between.
 */
export async function mergeSettings(providerId: string, patch: Record<string, string>): Promise<void> {
  await db
    .update(providers)
    .set({
      settings: sql`${providers.settings} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(providers.id, providerId));
}

/**
 * Who is asking. Management is unscoped-key-only (matching `POST /v1/domains`), so unlike
 * `DomainCaller` this carries no domain filter to apply — `domainIds` is only ever checked for
 * emptiness. A dashboard session with no domain scope of its own passes an empty array here too.
 */
export interface ProviderCaller {
  organizationId: string;
  domainIds: string[];
  actor: ActivityActor;
}

export function assertUnscoped(caller: ProviderCaller, action: string): void {
  if (caller.domainIds.length > 0) {
    throw new ApiError("key_not_scoped", `This key is scoped to specific domains and can't ${action}.`);
  }
}

/**
 * Loads a provider in the caller's organization, or throws `not_found`. Shared providers are the
 * operator's alone. `field` names the request field the id came from.
 */
export async function loadProvider(caller: Pick<ProviderCaller, "organizationId">, id: string, field = "id"): Promise<ProviderRow> {
  const [provider] = await db
    .select()
    .from(providers)
    .where(and(eq(providers.organizationId, caller.organizationId), eq(providers.id, id), eq(providers.shared, false)))
    .limit(1);
  if (!provider) throw new ApiError("not_found", `No provider with id ${id}.`, { field });
  return provider;
}

/** Validates a credentials object against its adapter's schema. Unknown fields are dropped. */
export function validateCredentials(adapter: string, credentials: Record<string, string>): Record<string, string> {
  const result = credentialsSchemaOf(adapter).safeParse(credentials);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue ? `credentials.${issue.path.join(".")}` : "credentials";
    throw new ApiError("validation_failed", `Field "${field}" isn't valid: ${issue?.message ?? "credentials aren't valid"}.`, {
      field: "credentials",
    });
  }
  return result.data as Record<string, string>;
}

/** Validates a settings object against its adapter's schema. `partial` allows a subset, for a merge. */
export function validateSettings(adapter: string, settings: ProviderSettings, options: { partial?: boolean } = {}): ProviderSettings {
  const schema = settingsSchemaOf(adapter);
  const result = (options.partial ? schema.partial() : schema).safeParse(settings);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue ? `settings.${issue.path.join(".")}` : "settings";
    throw new ApiError("validation_failed", `Field "${field}" isn't valid: ${issue?.message ?? "settings aren't valid"}.`, {
      field: "settings",
    });
  }
  return result.data as ProviderSettings;
}

/**
 * Calls the adapter's cheap health probe with the credentials about to be stored, and refuses
 * them outright when it answers `false`. `null` means the adapter has no way to check itself
 * (Mailpace with no organization token) — that isn't a pass, it's "can't tell", and the caller
 * proceeds on the same trust a hand-edited row would have carried, with the outcome recorded on
 * the activity row so it's visible later.
 */
export async function verifyOrThrow(
  adapter: string,
  credentials: Record<string, string>,
  settings: ProviderSettings,
  providerId: string,
): Promise<AdapterHealth["ok"]> {
  const client = buildAdapter(adapter, credentials, settings, providerId);
  const health = await client.healthCheck();
  if (health.ok === false) {
    throw new ApiError("credentials_rejected", health.detail ?? "The provider refused these credentials.");
  }
  return health.ok;
}

export interface ProviderPage {
  data: OrganizationProvider[];
  next_cursor: string | null;
}

/** A assignment row reports its shared provider's backoff when that one runs longer. */
export async function withSharedBackoff(rows: ProviderRow[]): Promise<ProviderRow[]> {
  const sharedIds = [...new Set(rows.flatMap((row) => (row.sharedProviderId ? [row.sharedProviderId] : [])))];
  if (sharedIds.length === 0) return rows;
  const shared = await db
    .select({ id: providers.id, backoffUntil: providers.backoffUntil })
    .from(providers)
    .where(inArray(providers.id, sharedIds));
  const untilById = new Map(shared.map((row) => [row.id, row.backoffUntil]));
  return rows.map((row) => {
    const until = row.sharedProviderId ? untilById.get(row.sharedProviderId) : null;
    if (!until || (row.backoffUntil && row.backoffUntil >= until)) return row;
    return { ...row, backoffUntil: until };
  });
}

/**
 * Tells an organization whether it can send through each row, with no provider detail. Without
 * `status`, the health records and domain counts aren't read and every row reads ready.
 */
async function forOrganization(organizationId: string, rows: ProviderRow[], options: { status?: boolean } = {}): Promise<OrganizationProvider[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const withStatus = options.status !== false;
  const [[organization], bound, health] = await Promise.all([
    db
      .select({ providerId: organizations.providerId, suspendSource: organizations.suspendSource })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1),
    withStatus
      ? db
          .select({ id: domains.providerId, count: sql<number>`count(*)::int` })
          .from(domains)
          .where(inArray(domains.providerId, ids))
          .groupBy(domains.providerId)
      : [],
    withStatus ? Promise.all(ids.map((id) => readProviderRecord(id))) : [],
  ]);
  if (!withStatus) {
    return rows.map((row) => ({ ...serializeProvider(row), assigned: organization?.providerId === row.id, status: "ready" }));
  }
  const boundById = new Map(bound.map((row) => [row.id, row.count]));
  const now = Date.now();

  return (await withSharedBackoff(rows)).map((row, index): OrganizationProvider => {
    const onShared = row.sharedProviderId !== null;
    let status: ProviderStatus = "ready";
    if ((row.backoffUntil && row.backoffUntil.getTime() > now) || (onShared && organization?.suspendSource === "provider")) {
      status = "paused";
    } else if (health[index]?.ok === false) {
      status = "unavailable";
    } else if (assignmentSettingUp(row, boundById.get(row.id) ?? 0)) {
      status = "setting_up";
    }
    return { ...serializeProvider(row), assigned: organization?.providerId === row.id, status };
  });
}

export async function listProviders(
  caller: ProviderCaller,
  limit: number,
  cursor?: string,
  options: { status?: boolean } = {},
): Promise<ProviderPage> {
  assertUnscoped(caller, "list providers");

  // Scoped like every other read here: a foreign id must not become a pagination anchor.
  const after = cursor
    ? await db
        .select({ createdAt: providers.createdAt, id: providers.id })
        .from(providers)
        .where(and(eq(providers.organizationId, caller.organizationId), eq(providers.id, cursor), eq(providers.shared, false)))
        .limit(1)
    : [];
  const edge = after[0];

  const rows = await db
    .select()
    .from(providers)
    .where(
      and(
        eq(providers.organizationId, caller.organizationId),
        eq(providers.shared, false),
        edge ? keysetBefore({ table: providers, sort: providers.createdAt, id: providers.id }, edge.id) : undefined,
      ),
    )
    .orderBy(desc(providers.createdAt), desc(providers.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return {
    data: await forOrganization(caller.organizationId, page, options),
    next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function readProvider(caller: ProviderCaller, id: string, options: { status?: boolean } = {}): Promise<OrganizationProvider> {
  assertUnscoped(caller, "read providers");
  const [provider] = await forOrganization(caller.organizationId, [await loadProvider(caller, id)], options);
  return provider!;
}

export { serializeProvider };
export type { OrganizationProvider, SerializedProvider };
