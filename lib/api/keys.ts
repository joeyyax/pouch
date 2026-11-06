import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, users } from "@/lib/db/schema";
import { sha256 } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { redis } from "@/lib/redis";
import { ApiError } from "./errors";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("keys");

export type ApiKeyRow = typeof apiKeys.$inferSelect;
/** A key that acts as an organization: anything but an admin key. */
export type OrganizationKeyRow = ApiKeyRow & { organizationId: string };
export type KeyMode = "live" | "test";

const SECRET_PREFIX: Record<KeyMode, string> = { live: "sk_live_", test: "sk_test_" };

export interface GeneratedKey {
  secret: string;
  secretHash: string;
  secretPrefix: string;
  mode: KeyMode;
}

/** Mints a key secret. The secret is returned once and only its hash is stored. */
export function generateKeySecret(mode: KeyMode): GeneratedKey {
  const secret = `${SECRET_PREFIX[mode]}${randomBytes(24).toString("base64url")}`;
  return { secret, secretHash: sha256(secret), secretPrefix: secret.slice(0, 16), mode };
}

export function modeOf(secret: string): KeyMode | null {
  if (secret.startsWith(SECRET_PREFIX.test)) return "test";
  if (secret.startsWith(SECRET_PREFIX.live)) return "live";
  return null;
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) throw new ApiError("invalid_key", "Authorization header must be `Bearer <key>`.");
  return match[1];
}

/**
 * Resolves a key secret to its row. Throws `invalid_key` when it's missing, unknown or
 * revoked, or when it's an admin key whose creator isn't an admin. The one place a secret is
 * checked: the HTTP bearer path and the SMTP AUTH PLAIN path (`lib/smtp/auth.ts`) both call this.
 */
export async function authenticateSecret(secret: string): Promise<ApiKeyRow> {
  if (!modeOf(secret)) throw new ApiError("invalid_key", "This key isn't valid.");

  const [row] = await db
    .select({ key: apiKeys, creatorIsAdmin: users.admin })
    .from(apiKeys)
    .leftJoin(users, eq(users.id, apiKeys.createdBy))
    .where(eq(apiKeys.secretHash, sha256(secret)))
    .limit(1);
  const key = row?.key;
  if (!key || key.revokedAt) throw new ApiError("invalid_key", "This key isn't valid.");
  // Covers an admin flag changed outside `setAdmin`.
  if (key.scope === "admin" && !row.creatorIsAdmin) {
    throw new ApiError("invalid_key", "This admin key's creator is no longer an admin.");
  }

  return key;
}

/** Throws `admin_key_required` unless the key has the admin scope. */
export function requireAdminKey(key: ApiKeyRow): void {
  if (key.scope !== "admin") {
    throw new ApiError("admin_key_required", "This route needs an admin key. Create one at Admin settings → API keys.");
  }
}

/** Throws `organization_key_required` on an admin key, which has no organization to act as. */
export function requireOrganizationKey(key: ApiKeyRow): OrganizationKeyRow {
  if (key.scope === "admin" || key.organizationId === null) {
    throw new ApiError(
      "organization_key_required",
      "This route needs an organization key. An admin key belongs to no organization and reaches the admin API instead.",
    );
  }
  return key as OrganizationKeyRow;
}

/** Resolves the bearer key. Throws `invalid_key` when it's missing, unknown or revoked. */
export async function authenticateKey(request: Request): Promise<ApiKeyRow> {
  return authenticateSecret(bearer(request));
}

/** Anything that carries a domain scope: an API key, or a dashboard session with none. */
export interface DomainScoped {
  /** Domain ids the caller may reach. Empty means every domain in the organization. */
  domainIds: string[];
}

/** Refuses a test key on a route that reads only live data. The sandbox stays a sandbox. */
export function assertLiveKey(key: { mode: KeyMode }, what: string): void {
  if (key.mode === "test") throw new ApiError("key_not_scoped", `A test-mode key can't ${what}.`);
}

export function keyCanAccessDomain(key: DomainScoped, domainId: string): boolean {
  return key.domainIds.length === 0 || key.domainIds.includes(domainId);
}

/** How stale `last_used_at` may be. One request per key per window reaches Postgres. */
const KEY_USE_RESOLUTION_MS = 60_000;
/** Keys held in the fallback before the expired ones are swept. */
const KEY_USE_MEMORY_LIMIT = 1_000;

const recordedUse = new Map<string, number>();

function claimInMemory(keyId: string, now: number): boolean {
  const last = recordedUse.get(keyId);
  if (last !== undefined && now - last < KEY_USE_RESOLUTION_MS) return false;
  if (recordedUse.size >= KEY_USE_MEMORY_LIMIT) {
    for (const [id, at] of recordedUse) if (now - at >= KEY_USE_RESOLUTION_MS) recordedUse.delete(id);
  }
  recordedUse.set(keyId, now);
  return true;
}

/** Whether this key's use is the first of its window. Redis-backed, with an in-process fallback. */
async function claimKeyUseWindow(keyId: string): Promise<boolean> {
  const client = redis();
  if (client) {
    try {
      return (await client.set(`keyuse:${keyId}`, "1", "PX", KEY_USE_RESOLUTION_MS, "NX")) === "OK";
    } catch (err) {
      log.warn(`key use throttle fell back to memory: ${safeErrorMessage(err)}`);
    }
  }
  return claimInMemory(keyId, Date.now());
}

/**
 * Stamps `last_used_at`. Throttled to one write per key per minute so a send doesn't carry an
 * extra row update, which still resolves "is this key dead" for an operator about to revoke it.
 */
export async function recordKeyUse(keyId: string): Promise<void> {
  if (!(await claimKeyUseWindow(keyId))) return;
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, keyId));
}

export function resetKeyUseMemory(): void {
  recordedUse.clear();
}
