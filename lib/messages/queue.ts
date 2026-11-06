import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, messages, providers } from "@/lib/db/schema";
import type { MessageRow } from "@/lib/db/schema";
import type { ProviderRow } from "@/lib/providers";
import type { DomainLayout } from "@/lib/domains/layout";
import { redis, redisChannel } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("queue");

export function queueChannel(): string {
  return redisChannel("messages:queued");
}

/** Longest a claimed row may stay locked before another worker may take it. */
export const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export interface ClaimedMessage {
  message: MessageRow;
  provider: ProviderRow;
  /** The sending domain's frame, when it has one. Applied only to a send that asked for it. */
  layout: DomainLayout | null;
  /** The sending domain's name — the layout's brand-name fallback for a row saved before it existed. */
  domainName: string;
  /** The organization holding the sending domain, which is also the service's own mail's carrier. */
  domainOrganizationId: string;
}

export interface DueProvider {
  id: string;
  concurrency: number;
  adapter: string;
  providerIdentity: string | null;
  shared: boolean;
  /** The shared provider this assignment row sends through, or null. */
  sharedProviderId: string | null;
}

/** An assignment's shared provider, joined so its backoff holds every organization on it. */
const sharedProviders = alias(providers, "shared_provider");

/**
 * A message is claimable when it's queued, due, unlocked, its domain isn't stalled and its
 * provider isn't backing off. `now` is the database's clock, so every timestamp here is compared
 * against the one that wrote it — see lib/db/clock.ts.
 */
function claimable(now: Date) {
  const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
  return and(
    eq(messages.status, "queued"),
    lte(messages.nextAttemptAt, now),
    or(isNull(messages.lockedAt), lte(messages.lockedAt, staleBefore)),
    // A stalled domain's mail isn't claimed at all. worker/send.ts still rechecks, for a domain
    // stalled after the claim.
    isNull(domains.stalledAt),
    or(isNull(providers.backoffUntil), lte(providers.backoffUntil, now)),
    or(isNull(sharedProviders.backoffUntil), lte(sharedProviders.backoffUntil, now)),
  );
}

/** Providers with work waiting, and how many sends each allows at once. */
export async function dueProviders(): Promise<DueProvider[]> {
  const now = await dbNow();
  const rows = await db
    .selectDistinct({
      id: providers.id,
      concurrency: providers.concurrency,
      adapter: providers.adapter,
      providerIdentity: providers.providerIdentity,
      shared: providers.shared,
      sharedProviderId: providers.sharedProviderId,
    })
    .from(messages)
    .innerJoin(domains, eq(domains.id, messages.domainId))
    .innerJoin(providers, eq(providers.id, domains.providerId))
    .leftJoin(sharedProviders, eq(sharedProviders.id, providers.sharedProviderId))
    .where(claimable(now));
  return rows;
}

export interface ClaimOptions {
  workerId: string;
  providerId: string;
  limit: number;
}

/**
 * Claims up to `limit` due messages on one provider, skipping rows another
 * worker holds. Claiming per provider is what keeps one slow provider from starving the rest.
 */
export async function claimMessages(options: ClaimOptions): Promise<ClaimedMessage[]> {
  if (options.limit <= 0) return [];

  return db.transaction(async (tx) => {
    const now = await dbNow(tx);
    const candidates = await tx
      .select({ id: messages.id, provider: providers, layout: domains.layout, domainName: domains.name, domainOrganizationId: domains.organizationId })
      .from(messages)
      .innerJoin(domains, eq(domains.id, messages.domainId))
      .innerJoin(providers, eq(providers.id, domains.providerId))
      .leftJoin(sharedProviders, eq(sharedProviders.id, providers.sharedProviderId))
      .where(and(claimable(now), eq(providers.id, options.providerId)))
      // Rate-shaping (#7): a transactional row (batch_id null) always claims ahead of a
      // batch row on the same provider, so a large batch can never starve a password reset
      // or a receipt sharing that provider's concurrency. Oldest-first within each class.
      .orderBy(sql`(${messages.batchId} is not null)`, asc(messages.nextAttemptAt))
      .limit(options.limit)
      .for("update", { of: messages, skipLocked: true });

    const provider = candidates[0]?.provider;
    if (!provider) return [];

    const claimed = await tx
      .update(messages)
      .set({ lockedAt: now, lockedBy: options.workerId, updatedAt: now })
      .where(
        inArray(
          messages.id,
          candidates.map((row) => row.id),
        ),
      )
      .returning();

    // A batch shares one provider but can span domains, so the frame is looked up per row.
    const layouts = new Map(candidates.map((row) => [row.id, row.layout]));
    const domainNames = new Map(candidates.map((row) => [row.id, row.domainName]));
    const domainOrganizations = new Map(candidates.map((row) => [row.id, row.domainOrganizationId]));
    return claimed.map((message) => ({
      message,
      provider,
      layout: layouts.get(message.id) ?? null,
      domainName: domainNames.get(message.id) ?? "",
      domainOrganizationId: domainOrganizations.get(message.id) ?? message.organizationId ?? "",
    }));
  });
}

/** Publishes a nudge so an idle worker picks the message up without waiting for its next poll. */
export async function notifyQueued(messageId: string): Promise<void> {
  const client = redis();
  if (!client) return;
  try {
    await client.publish(queueChannel(), messageId);
  } catch (err) {
    log.warn(`publish failed: ${safeErrorMessage(err)}`);
  }
}

/** Clears locks left behind by a worker that exited without releasing them. */
export async function releaseStaleLocks(): Promise<number> {
  const now = await dbNow();
  const released = await db
    .update(messages)
    .set({ lockedAt: null, lockedBy: null })
    .where(and(eq(messages.status, "queued"), lt(messages.lockedAt, new Date(now.getTime() - LOCK_TIMEOUT_MS))))
    .returning({ id: messages.id });
  return released.length;
}
