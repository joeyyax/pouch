/**
 * Minting and revoking keys, split from `lib/api/keys.ts` so the read and authenticate paths
 * don't pull the mail stack.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { apiKeys, users } from "@/lib/db/schema";
import { dropRevokedKeyDeliveries } from "@/lib/webhooks/queue";
import type { ApiKeyRevokedReason, ApiKeyScope } from "@/lib/db/schema/api-keys";
import { newId } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { sendKeyCreatedAlert } from "@/lib/mail/alerts/key-created";
import { sendKeyRevokedAlert } from "@/lib/mail/alerts/key-revoked";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { readSetting } from "@/lib/settings/values";
import { ApiError } from "./errors";
import { generateKeySecret, type ApiKeyRow, type KeyMode } from "./keys";

const log = logger.child("api:key-lifecycle");

export interface CreateKeyInput {
  /** Null for an admin key, which belongs to the service. */
  organizationId: string | null;
  name: string;
  mode: KeyMode;
  /** Domain ids the key may send from. Empty means every domain in the organization. */
  domainIds: string[];
  /** Absent takes the install's default for new keys. */
  rateLimit?: number;
  /** Defaults to `organization`. */
  scope?: ApiKeyScope;
  /** The user minting the key. Required for an admin key. */
  createdBy?: string | null;
}

export interface MintedKey {
  key: ApiKeyRow;
  /** Shown once. Only its hash is stored. */
  secret: string;
}

/**
 * An admin key needs an admin creator, no organization, live mode and no domain limits.
 * Locks the creator's row so a concurrent demotion waits for the insert.
 */
async function assertAdminScopeAllowed(input: CreateKeyInput, executor: Executor): Promise<void> {
  const refuse = (message: string) => new ApiError("admin_scope_not_allowed", message);
  if (!input.createdBy) throw refuse("Only an admin can create an admin key.");

  const [creator] = await executor
    .select({ admin: users.admin })
    .from(users)
    .where(eq(users.id, input.createdBy))
    .for("share");
  if (!creator?.admin) throw refuse("Only an admin can create an admin key.");

  if (input.organizationId !== null) throw refuse("An admin key belongs to the service, not an organization.");
  if (input.domainIds.length > 0) throw refuse("An admin key can't be limited to domains.");
  if (input.mode !== "live") throw refuse("An admin key can't be a test key.");
}

/** The one place a key is minted. The seed, the fixtures and the dashboard all come through here. */
export async function createApiKey(input: CreateKeyInput, executor: Executor = db): Promise<MintedKey> {
  const generated = generateKeySecret(input.mode);
  const scope = input.scope ?? "organization";
  const rateLimit = input.rateLimit ?? (await readSetting("key_rate_limit_default"));
  const key = await executor.transaction(async (tx) => {
    if (scope === "admin") await assertAdminScopeAllowed(input, tx);
    const [inserted] = await tx
      .insert(apiKeys)
      .values({
        id: newId("key"),
        organizationId: input.organizationId,
        name: input.name,
        secretHash: generated.secretHash,
        secretPrefix: generated.secretPrefix,
        mode: generated.mode,
        domainIds: input.domainIds,
        scope,
        createdBy: input.createdBy ?? null,
        rateLimit,
      })
      .returning();
    return inserted;
  });

  if (!key) throw new ApiError("provider_unavailable", "The key couldn't be persisted.");

  // Best-effort: a notification failing here must never undo the key that triggered it.
  await sendKeyCreatedAlert(key).catch((err) => {
    const reason = safeErrorMessage(err);
    log.warn(`couldn't send the key-created alert for ${key.id}: ${reason}`);
  });

  return { key, secret: generated.secret };
}

/** Revokes a key of `scope` in the caller's organization, or a service-level key when null. Returns null when there's no such key. */
export async function revokeApiKey(
  organizationId: string | null,
  id: string,
  scope: ApiKeyScope = "organization",
): Promise<ApiKeyRow | null> {
  const [key] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        organizationId === null ? isNull(apiKeys.organizationId) : eq(apiKeys.organizationId, organizationId),
        eq(apiKeys.id, id),
        eq(apiKeys.scope, scope),
      ),
    )
    .returning();
  if (!key) return null;

  // Nothing already queued for the key's endpoints goes out either.
  await dropRevokedKeyDeliveries(db, key.id);

  await sendRevokedAlerts([key]);
  return key;
}

/**
 * Revokes every live admin key `userId` created. Runs inside the caller's transaction; send
 * `sendRevokedAlerts` after it commits.
 */
export async function revokeAdminKeysCreatedBy(
  userId: string,
  reason: ApiKeyRevokedReason,
  executor: Executor = db,
): Promise<ApiKeyRow[]> {
  return executor
    .update(apiKeys)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(apiKeys.createdBy, userId), eq(apiKeys.scope, "admin"), isNull(apiKeys.revokedAt)))
    .returning();
}

export async function sendRevokedAlerts(keys: ApiKeyRow[]): Promise<void> {
  for (const key of keys) {
    // Best-effort: a notification failing here must never undo the revoke that triggered it.
    await sendKeyRevokedAlert(key).catch((err) => {
      const reason = safeErrorMessage(err);
      log.warn(`couldn't send the key-revoked alert for ${key.id}: ${reason}`);
    });
  }
}
