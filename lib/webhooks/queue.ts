import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { apiKeys, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import type { WebhookDeliveryRow, WebhookEndpointRow } from "@/lib/db/schema";

/** Mirrors lib/messages/queue.ts LOCK_TIMEOUT_MS: longest a claimed row stays locked before it's reclaimable. */
export const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export interface ClaimedDelivery {
  delivery: WebhookDeliveryRow;
  endpoint: WebhookEndpointRow;
}

/** `now` is the database's clock, the same one that wrote these timestamps — lib/db/clock.ts. */
function claimable(now: Date) {
  const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
  return and(
    eq(webhookDeliveries.status, "pending"),
    lte(webhookDeliveries.nextAttemptAt, now),
    or(isNull(webhookDeliveries.lockedAt), lte(webhookDeliveries.lockedAt, staleBefore)),
    isNull(webhookEndpoints.disabledAt),
    // A domain's inbound endpoint has no key. A key's endpoints go quiet the moment it's revoked.
    or(isNull(webhookEndpoints.apiKeyId), isNull(apiKeys.revokedAt)),
  );
}

/** Exhausts pending deliveries to endpoints of a revoked key: all of them, or only `keyId`'s. */
export async function dropRevokedKeyDeliveries(executor: Executor = db, keyId?: string): Promise<number> {
  const endpoints = executor
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .innerJoin(apiKeys, eq(apiKeys.id, webhookEndpoints.apiKeyId))
    .where(keyId ? eq(apiKeys.id, keyId) : isNotNull(apiKeys.revokedAt));
  const dropped = await executor
    .update(webhookDeliveries)
    .set({ status: "exhausted", lastError: "The key was revoked.", lockedAt: null, lockedBy: null })
    .where(and(eq(webhookDeliveries.status, "pending"), inArray(webhookDeliveries.endpointId, endpoints)))
    .returning({ id: webhookDeliveries.id });
  return dropped.length;
}

/**
 * Claims up to `limit` due deliveries whose endpoint isn't disabled, skipping rows another
 * worker holds. Same FOR UPDATE SKIP LOCKED + locked_at/locked_by pattern as claimMessages.
 */
export async function claimDeliveries(workerId: string, limit: number): Promise<ClaimedDelivery[]> {
  if (limit <= 0) return [];
  // Catches a delivery queued while its key's revoke was committing.
  await dropRevokedKeyDeliveries();

  return db.transaction(async (tx) => {
    const now = await dbNow(tx);
    const candidates = await tx
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .leftJoin(apiKeys, eq(apiKeys.id, webhookEndpoints.apiKeyId))
      .where(claimable(now))
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(limit)
      .for("update", { of: webhookDeliveries, skipLocked: true });

    if (candidates.length === 0) return [];
    const ids = candidates.map((row) => row.id);

    const claimed = await tx
      .update(webhookDeliveries)
      .set({ lockedAt: now, lockedBy: workerId })
      .where(inArray(webhookDeliveries.id, ids))
      .returning();

    const endpointIds = [...new Set(claimed.map((delivery) => delivery.endpointId))];
    const endpoints = await tx.select().from(webhookEndpoints).where(inArray(webhookEndpoints.id, endpointIds));
    const byId = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));

    return claimed.flatMap((delivery) => {
      const endpoint = byId.get(delivery.endpointId);
      return endpoint ? [{ delivery, endpoint }] : [];
    });
  });
}

/** Clears locks left behind by a worker that exited without releasing them. */
export async function releaseStaleWebhookLocks(): Promise<number> {
  const now = await dbNow();
  const released = await db
    .update(webhookDeliveries)
    .set({ lockedAt: null, lockedBy: null })
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        lt(webhookDeliveries.lockedAt, new Date(now.getTime() - LOCK_TIMEOUT_MS)),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return released.length;
}
