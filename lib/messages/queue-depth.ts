/** What the queue holds right now. The one definition the overview, Settings → Sending and `GET /v1/stats` read. */
import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messages, providers } from "@/lib/db/schema";
import { withSharedBackoff } from "@/lib/providers";
import { holdsQueue, suspensionOf } from "@/lib/suspension";
import { ABANDON_MS, SILENT_MS } from "@/lib/metrics/conditions";
import { messageScope, type StatsScope } from "@/lib/stats/cells";
import { heldCondition } from "./held";

export interface QueueDepth {
  /** Every queued message: due, backing off and held. */
  queued: number;
  /** Due now and waiting on a worker. */
  due: number;
  /** Waiting out a retry delay or the provider's backoff. */
  backing_off: number;
  /** Held by a domain stall or a suspension that holds the queue, the hold `held=true` lists. */
  held: number;
  /** Claimed by a worker mid-send. */
  in_progress: number;
  /** Handed over between an hour and a day ago with no word back. */
  silent: number;
  oldest_queued_at: Date | null;
  oldest_due_at: Date | null;
  oldest_held_at: Date | null;
  /** Domains a stall holds. Empty while the organization's own suspension holds everything. */
  held_by_domain: { domain_id: string; count: number; oldest_queued_at: Date }[];
  /** The organization's suspension holds its queue. */
  organization_held: boolean;
  /** The organization's suspension fails its queued mail instead. */
  organization_fails: boolean;
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/** `now` is the database's clock: `next_attempt_at` and `backoff_until` were written with it. */
export async function queueDepth(scope: StatsScope, now: Date): Promise<QueueDepth> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const held = heldCondition();
  const byDomain = await db
    .select({
      domainId: messages.domainId,
      providerId: domains.providerId,
      total: sql<number>`count(*)::int`,
      held: sql<number>`count(*) filter (where ${held})::int`,
      due: sql<number>`count(*) filter (where not ${held} and ${messages.nextAttemptAt} <= ${at})::int`,
      backingOff: sql<number>`count(*) filter (where not ${held} and ${messages.nextAttemptAt} > ${at})::int`,
      oldest: sql<string | null>`min(${messages.createdAt})`,
      oldestHeld: sql<string | null>`min(${messages.createdAt}) filter (where ${held})`,
      oldestDue: sql<string | null>`min(${messages.createdAt}) filter (where not ${held} and ${messages.nextAttemptAt} <= ${at})`,
    })
    .from(messages)
    .innerJoin(domains, eq(domains.id, messages.domainId))
    .where(and(messageScope(scope), eq(messages.status, "queued")))
    .groupBy(messages.domainId, domains.providerId);

  const suspension = await suspensionOf(scope.organizationId);
  const organizationHeld = suspension ? holdsQueue(suspension.source) : false;

  // The claim also skips a due message while its provider, or that provider's shared provider, backs off.
  const providerIds = [...new Set(byDomain.filter((row) => row.due + row.backingOff > 0).map((row) => row.providerId))];
  const providerRows = providerIds.length
    ? await withSharedBackoff(await db.select().from(providers).where(inArray(providers.id, providerIds)))
    : [];
  const backingOffProviders = new Set(
    providerRows.filter((provider) => provider.backoffUntil && provider.backoffUntil > now).map((provider) => provider.id),
  );

  const depth: QueueDepth = {
    queued: 0,
    due: 0,
    backing_off: 0,
    held: 0,
    in_progress: 0,
    silent: 0,
    oldest_queued_at: null,
    oldest_due_at: null,
    oldest_held_at: null,
    held_by_domain: [],
    organization_held: organizationHeld,
    organization_fails: Boolean(suspension) && !organizationHeld,
  };
  for (const row of byDomain) {
    const oldestHeld = row.oldestHeld ? new Date(row.oldestHeld) : null;
    depth.queued += row.total;
    depth.held += row.held;
    depth.oldest_queued_at = earliest(depth.oldest_queued_at, row.oldest ? new Date(row.oldest) : null);
    depth.oldest_held_at = earliest(depth.oldest_held_at, oldestHeld);
    if (!organizationHeld && row.held > 0 && oldestHeld) {
      depth.held_by_domain.push({ domain_id: row.domainId, count: row.held, oldest_queued_at: oldestHeld });
    }
    if (backingOffProviders.has(row.providerId)) {
      depth.backing_off += row.due + row.backingOff;
      continue;
    }
    depth.due += row.due;
    depth.backing_off += row.backingOff;
    depth.oldest_due_at = earliest(depth.oldest_due_at, row.oldestDue ? new Date(row.oldestDue) : null);
  }

  const [[locked], [silent]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(messageScope(scope), isNotNull(messages.lockedAt))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          messageScope(scope),
          eq(messages.status, "sent"),
          isNull(messages.abandonedAt),
          lte(messages.sentAt, new Date(now.getTime() - SILENT_MS)),
          // A backstop: the abandon sweep is what clears a row, and this keeps one it missed from counting forever.
          gte(messages.sentAt, new Date(now.getTime() - ABANDON_MS)),
        ),
      ),
  ]);
  depth.in_progress = locked?.count ?? 0;
  depth.silent = silent?.count ?? 0;
  return depth;
}
