/**
 * Organization API keys, defined once for every surface: `/v1/keys`, the MCP tools over it and
 * the Keys screen's server actions. Admin keys are in `./admin.ts`, dashboard only —
 * see docs/decisions.md, "Admin keys die with their creator's admin role".
 */
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, domains } from "@/lib/db/schema";
import type { ApiKeyScope } from "@/lib/db/schema/api-keys";
import type { ApiKeyRow } from "@/lib/api/keys";
import { keysetBefore } from "@/lib/db/keyset";
import { ApiError } from "@/lib/api/errors";
import { createApiKey, revokeApiKey } from "@/lib/api/key-lifecycle";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import type { CreateKeyRequest, UpdateKeyRequest } from "@/lib/schemas/key";

/** Who is asking. An API key and a dashboard session differ only in what they're limited to. */
export interface KeyCaller {
  organizationId: string;
  /** Domains the caller is limited to. Empty means every domain. */
  domainIds: string[];
  actor: ActivityActor;
  /** Set for an API key caller: the mode it may mint. Undefined for a dashboard session. */
  mode?: ApiKeyRow["mode"];
  /** The user minting the key, recorded on the row. Null for an API-minted key. */
  createdBy?: string | null;
}

export interface SerializedKey {
  id: string;
  name: string;
  mode: ApiKeyRow["mode"];
  secret_prefix: string;
  domain_ids: string[];
  rate_limit: number;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface KeyPage {
  data: SerializedKey[];
  next_cursor: string | null;
}

export function serializeKey(row: ApiKeyRow): SerializedKey {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    secret_prefix: row.secretPrefix,
    domain_ids: row.domainIds,
    rate_limit: row.rateLimit,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

/** Admin keys never show on an organization's own Keys screen or under `/v1/keys`. */
const ORGANIZATION_SCOPE = eq(apiKeys.scope, "organization");

/** A key sees only keys of its own mode, so a test key can't read, widen or revoke a live one. */
function sameMode(caller: KeyCaller) {
  return caller.mode ? eq(apiKeys.mode, caller.mode) : undefined;
}

/**
 * Key management is whole-organization: a key limited to domains could otherwise mint one
 * limited to none. See docs/decisions.md, "Managing keys by API needs an unlimited key".
 */
function assertMayManageKeys(caller: KeyCaller): void {
  if (caller.domainIds.length > 0) {
    throw new ApiError("key_not_scoped", "This key is limited to domains, so it can't manage keys.");
  }
}

/** Every domain named has to be in the organization, or a key would be scoped to a row it can never reach. */
async function assertDomainsExist(organizationId: string, domainIds: string[]): Promise<void> {
  if (domainIds.length === 0) return;
  const found = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), inArray(domains.id, domainIds)));
  if (found.length !== new Set(domainIds).size) {
    throw new ApiError("not_found", "One of those domains isn't in this organization.", { field: "domain_ids" });
  }
}

export async function assertNameAvailable(
  organizationId: string | null,
  name: string,
  excludingId?: string,
  scope: ApiKeyScope = "organization",
): Promise<void> {
  const [clash] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        organizationId === null ? isNull(apiKeys.organizationId) : eq(apiKeys.organizationId, organizationId),
        eq(apiKeys.scope, scope),
        eq(apiKeys.name, name),
        isNull(apiKeys.revokedAt),
      ),
    )
    .limit(1);
  if (clash && clash.id !== excludingId) {
    throw new ApiError("validation_failed", `A live key is already named ${name}.`, { field: "name" });
  }
}

export interface MintedKeyResponse extends SerializedKey {
  /** Shown once. Only its hash is stored. */
  secret: string;
}

export async function createKey(caller: KeyCaller, request: CreateKeyRequest): Promise<MintedKeyResponse> {
  assertMayManageKeys(caller);
  if (caller.mode && request.mode !== caller.mode) {
    throw new ApiError("validation_failed", `A ${caller.mode}-mode key can only create ${caller.mode}-mode keys.`, {
      field: "mode",
    });
  }

  await assertDomainsExist(caller.organizationId, request.domain_ids);
  await assertNameAvailable(caller.organizationId, request.name);

  const minted = await createApiKey({
    organizationId: caller.organizationId,
    name: request.name,
    mode: request.mode,
    domainIds: request.domain_ids,
    rateLimit: request.rate_limit,
    createdBy: caller.createdBy ?? null,
  });

  await recordActivity({
    organizationId: caller.organizationId,
    action: "key.created",
    actor: caller.actor,
    appliesTo: minted.key.id,
    subjectLabel: minted.key.name,
    metadata: { mode: minted.key.mode },
  });

  return { ...serializeKey(minted.key), secret: minted.secret };
}

export async function listKeys(
  caller: KeyCaller,
  limit: number,
  cursor: string | undefined,
  filters: { mode?: ApiKeyRow["mode"]; revoked?: "true" | "false"; domain?: string },
): Promise<KeyPage> {
  assertMayManageKeys(caller);

  const rows = await db
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.organizationId, caller.organizationId),
        ORGANIZATION_SCOPE,
        sameMode(caller),
        ...(filters.mode ? [eq(apiKeys.mode, filters.mode)] : []),
        ...(filters.revoked === "true" ? [isNotNull(apiKeys.revokedAt)] : []),
        ...(filters.revoked === "false" ? [isNull(apiKeys.revokedAt)] : []),
        ...(filters.domain ? [sql`(cardinality(${apiKeys.domainIds}) = 0 or ${apiKeys.domainIds} @> ARRAY[${filters.domain}]::text[])`] : []),
        ...(cursor ? [keysetBefore({ table: apiKeys, sort: apiKeys.createdAt, id: apiKeys.id }, cursor)] : []),
      ),
    )
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return {
    data: page.map(serializeKey),
    next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function readKey(caller: KeyCaller, id: string): Promise<SerializedKey> {
  return serializeKey(await keyRow(caller, id));
}

export async function updateKey(caller: KeyCaller, id: string, request: UpdateKeyRequest): Promise<SerializedKey> {
  const existing = await keyRow(caller, id);
  if (existing.revokedAt) throw new ApiError("validation_failed", "A revoked key can't be edited.");

  if (request.domain_ids !== undefined) await assertDomainsExist(caller.organizationId, request.domain_ids);
  if (request.name !== undefined && request.name !== existing.name) {
    await assertNameAvailable(caller.organizationId, request.name, id);
  }

  const [key] = await db
    .update(apiKeys)
    .set({
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.rate_limit !== undefined ? { rateLimit: request.rate_limit } : {}),
      ...(request.domain_ids !== undefined ? { domainIds: request.domain_ids } : {}),
    })
    .where(and(eq(apiKeys.organizationId, caller.organizationId), eq(apiKeys.id, id), ORGANIZATION_SCOPE))
    .returning();
  if (!key) throw new ApiError("provider_unavailable", "The key couldn't be updated.");

  await recordKeyEdit(caller, existing, key);
  return serializeKey(key);
}

export async function revokeKey(caller: KeyCaller, id: string): Promise<SerializedKey> {
  await keyRow(caller, id);
  const key = await revokeApiKey(caller.organizationId, id);
  if (!key) throw new ApiError("not_found", `No key with id ${id}.`);

  await recordActivity({
    organizationId: caller.organizationId,
    action: "key.revoked",
    actor: caller.actor,
    appliesTo: key.id,
    subjectLabel: key.name,
  });
  return serializeKey(key);
}

/** Loads an organization key the caller may manage, or throws the error that says why not. */
async function keyRow(caller: KeyCaller, id: string): Promise<ApiKeyRow> {
  assertMayManageKeys(caller);
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, caller.organizationId), eq(apiKeys.id, id), ORGANIZATION_SCOPE, sameMode(caller)))
    .limit(1);
  if (!row) throw new ApiError("not_found", `No key with id ${id}.`);
  return row;
}

/** A rate limit or a domain scope changing is a privilege change, so each is recorded on its own. */
async function recordKeyEdit(caller: KeyCaller, before: ApiKeyRow, after: ApiKeyRow): Promise<void> {
  if (before.rateLimit !== after.rateLimit) {
    await recordActivity({
      organizationId: caller.organizationId,
      action: "key.rate_limit.changed",
      actor: caller.actor,
      appliesTo: after.id,
      subjectLabel: after.name,
      metadata: { from: before.rateLimit, to: after.rateLimit },
    });
  }

  const rescoped =
    before.domainIds.length !== after.domainIds.length ||
    before.domainIds.some((id) => !after.domainIds.includes(id));
  if (!rescoped) return;

  const names = await domainNamesById(caller.organizationId);
  const label = (ids: string[]) => (ids.length === 0 ? "every domain" : ids.map((domainId) => names.get(domainId) ?? domainId).join(", "));
  await recordActivity({
    organizationId: caller.organizationId,
    action: "key.rescoped",
    actor: caller.actor,
    appliesTo: after.id,
    subjectLabel: after.name,
    metadata: { from: label(before.domainIds), to: label(after.domainIds) },
  });
}

export async function domainNamesById(organizationId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: domains.id, name: domains.name })
    .from(domains)
    .where(eq(domains.organizationId, organizationId));
  return new Map(rows.map((row) => [row.id, row.name]));
}
