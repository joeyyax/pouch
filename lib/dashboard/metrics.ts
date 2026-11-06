import { and, countDistinct, eq, gte, inArray, lt, min } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, messageEvents, messages, type MessageStatus } from "@/lib/db/schema";
import { messagesHref } from "@/lib/messages/link";
import { readDomainVolumes } from "@/lib/stats/baseline";
import { BASELINE_DAYS } from "@/lib/metrics/volume";
import { evaluateConditions, type Condition } from "@/lib/metrics/conditions";
import type { Latency } from "@/lib/metrics/duration";
import type { OutcomeCounts } from "@/lib/metrics/rates";
import { readOrganizationReputation } from "@/lib/reputation/read";
import { runObservations } from "@/lib/observations/_runner";
import { standingReason } from "@/lib/reputation/standing";
import { selectShape } from "@/lib/api/shape";
import { statsShape } from "@/lib/schemas/stats";
import { readStats, type LatencyQuantiles, type StatsBucket, type StatsResponse, type StatusCounts } from "@/lib/stats";
import { queueDepth } from "@/lib/messages/queue-depth";
import { bucketsIn, bucketUnit, metricsRange, type BucketUnit, type MetricsRange, type MetricsWindowDays } from "@/lib/metrics/window";
import { foldBuckets, foldTotals } from "@/lib/dashboard/local-buckets";
import { domainStallView } from "@/lib/dashboard/views/domains";
import type { MetricsOverview, DomainMetrics, VolumeDay, QueueReading, BounceReason } from "@/lib/dashboard/views/metrics";

/** The overview reads `GET /v1/stats` in UTC hours and folds them into the viewer's buckets. */
const OVERVIEW_SELECTION = selectShape(statsShape, { include: ["previous_buckets", "latency", "domains", "reasons"] });

const REASONS_SHOWN = 8;

/** In flight is handed over and unresolved. An abandoned message is waiting on nothing. */
function outcomeCounts(counts: StatusCounts): OutcomeCounts {
  return {
    total: counts.total,
    delivered: counts.delivered,
    bounced: counts.bounced,
    complained: counts.complained,
    failed: counts.failed,
    inFlight: counts.sent + counts.deferred - counts.abandoned,
    queued: counts.queued,
  };
}

function latency(quantiles: LatencyQuantiles): Latency {
  return { p50: quantiles.p50_ms, p95: quantiles.p95_ms, p99: quantiles.p99_ms, count: quantiles.count };
}

/** One bar per bucket, so an hour or day nothing was sent reads as a gap rather than a missing bar. */
function volume(buckets: StatsBucket[], range: MetricsRange, zone: string, unit: BucketUnit): VolumeDay[] {
  const folded = foldBuckets(buckets, zone, unit);
  return bucketsIn(range, zone, unit).map(({ date, key, label }) => {
    const counts = folded.get(key);
    return {
      date,
      label,
      delivered: counts?.delivered ?? 0,
      bounced: counts?.bounced ?? 0,
      complained: counts?.complained ?? 0,
      failed: counts?.failed ?? 0,
      pending: counts ? counts.queued + counts.sent + counts.deferred : 0,
    };
  });
}

async function domainMetrics(
  organizationId: string,
  stats: Pick<StatsResponse, "domains" | "buckets">,
  range: MetricsRange,
  zone: string,
  unit: BucketUnit,
): Promise<DomainMetrics[]> {
  const stallRows = await db
    .select({ domainId: domains.id, stalledAt: domains.stalledAt, stallReason: domains.stallReason, stallDetail: domains.stallDetail })
    .from(domains)
    .where(eq(domains.organizationId, organizationId));
  const stallByDomain = new Map(stallRows.map((row) => [row.domainId, domainStallView(row)]));
  const keys = bucketsIn(range, zone, unit).map((bucket) => bucket.key);
  const starts = stats.buckets.map((bucket) => bucket.start);

  return stats.domains.map((row) => {
    const daily = foldTotals(starts, row.buckets, zone, unit);
    return {
      domainId: row.domain_id,
      domainName: row.name,
      counts: outcomeCounts(row.counts),
      queueP95: row.queue_p95_ms,
      lastSentAt: row.last_sent_at ? new Date(row.last_sent_at) : null,
      stall: stallByDomain.get(row.domain_id) ?? null,
      daily: keys.map((key) => daily.get(key) ?? 0),
    };
  });
}

async function queueReading(organizationId: string, stats: Pick<StatsResponse, "attempts">, now: Date): Promise<QueueReading> {
  // The queue is every queued message, test mode included.
  const queue = await queueDepth({ organizationId, domainIds: [], mode: "all" }, now);
  const age = (at: Date | null) => (at ? now.getTime() - at.getTime() : null);
  return {
    due: queue.due,
    backingOff: queue.backing_off,
    held: queue.held,
    heldByDomain: queue.held_by_domain.map((row) => ({ domainId: row.domain_id, count: row.count, oldestMs: now.getTime() - row.oldest_queued_at.getTime() })),
    organizationHeld: queue.organization_held,
    organizationFails: queue.organization_fails,
    oldestHeldMs: age(queue.oldest_held_at),
    inFlight: queue.in_progress,
    silent: queue.silent,
    oldestDueMs: age(queue.oldest_due_at),
    retryPressure: stats.attempts.per_send ?? 0,
    previousRetryPressure: stats.attempts.previous_per_send ?? 0,
  };
}

/**
 * Where each reason's messages are: the message itself when there's one, else the list narrowed
 * to the reason, its statuses, the window and the domain when only one sent them.
 */
async function bounceReasons(organizationId: string, reasons: { reason: string; count: number }[], range: MetricsRange): Promise<BounceReason[]> {
  if (reasons.length === 0) return [];
  const rows = await db
    .select({
      reason: messageEvents.reason,
      status: messages.status,
      domain: domains.name,
      count: countDistinct(messages.id),
      messageId: min(messages.id),
    })
    .from(messageEvents)
    .innerJoin(messages, eq(messages.id, messageEvents.messageId))
    .innerJoin(domains, eq(domains.id, messages.domainId))
    .where(
      and(
        eq(messageEvents.organizationId, organizationId),
        inArray(messageEvents.status, ["bounced", "complained"]),
        inArray(
          messageEvents.reason,
          reasons.map((row) => row.reason),
        ),
        gte(messageEvents.occurredAt, range.since),
        eq(messages.testMode, false),
        gte(messages.createdAt, range.since),
        lt(messages.createdAt, range.until),
      ),
    )
    .groupBy(messageEvents.reason, messages.status, domains.name);

  return reasons.map(({ reason, count }) => {
    const matched = rows.filter((row) => row.reason === reason);
    const messageCount = matched.reduce((sum, row) => sum + row.count, 0);
    if (messageCount === 1 && matched[0]?.messageId) return { reason, count, href: `/messages/${matched[0].messageId}` };
    const names = [...new Set(matched.map((row) => row.domain))];
    const statuses = [...new Set(matched.map((row) => row.status))] as MessageStatus[];
    return {
      reason,
      count,
      href: messagesHref({ domain: names.length === 1 ? names[0] : undefined, statuses, days: range.days, reason }),
    };
  });
}

/** Whether this organization has ever sent anything, test mode included. */
async function hasEverSent(organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.organizationId, organizationId))
    .limit(1);
  return Boolean(row);
}

/** Whether a live message has ever been sent. Every count excludes test mode. */
async function hasEverSentLive(organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.organizationId, organizationId), eq(messages.testMode, false)))
    .limit(1);
  return Boolean(row);
}

/** `at` is for tests that pin the window; a real read takes the database's clock, like the queue. */
export async function readOverview(
  organizationId: string,
  days: MetricsWindowDays,
  zone: string,
  at?: Date,
): Promise<MetricsOverview> {
  const now = at ?? (await dbNow());
  const range = metricsRange(days, now);
  const unit = bucketUnit(days);

  const stats = (await readStats(
    { organizationId, domainIds: [] },
    { since: range.since, until: range.until, bucket: "hour" },
    OVERVIEW_SELECTION,
    now,
  )) as StatsResponse;
  const [queue, domainRows, everSent, everSentLive, reputation, volumes, reasons, observations] = await Promise.all([
    queueReading(organizationId, stats, now),
    domainMetrics(organizationId, stats, range, zone, unit),
    hasEverSent(organizationId),
    hasEverSentLive(organizationId),
    readOrganizationReputation(organizationId, now),
    readDomainVolumes(organizationId, BASELINE_DAYS, now),
    bounceReasons(organizationId, stats.reasons.slice(0, REASONS_SHOWN), range),
    runObservations(organizationId, now),
  ]);
  const counts = outcomeCounts(stats.counts);
  const previousRange = { ...range, since: range.previousSince, until: range.previousUntil };

  const conditions: Condition[] = evaluateConditions({
    days,
    oldestDueMs: queue.oldestDueMs,
    dueCount: queue.due,
    oldestHeldMs: queue.oldestHeldMs,
    heldCount: queue.held,
    queueFails: queue.organizationFails,
    silentCount: queue.silent,
    retryPressure: queue.retryPressure,
    previousRetryPressure: queue.previousRetryPressure,
    domains: domainRows.map((row) => ({
      domainId: row.domainId,
      domainName: row.domainName,
      counts: row.counts,
      stall: row.stall ? { reason: row.stall.reason, detail: row.stall.detail } : null,
      held: queue.heldByDomain.find((held) => held.domainId === row.domainId) ?? null,
    })),
    volumes,
    reputation: [
      { type: "organization", id: organizationId, standing: reputation.ownStanding, findings: reputation.findings },
      ...[...reputation.domains.values()].map((domain) => ({
        type: "domain" as const,
        id: domain.id,
        name: domain.name,
        standing: domain.standing,
        findings: domain.findings,
      })),
    ],
    observations,
  });

  return {
    days,
    since: range.since,
    until: range.until,
    counts,
    previousCounts: outcomeCounts(stats.previous_counts),
    queue,
    queueLatency: latency(stats.latency.queue),
    providerLatency: latency(stats.latency.provider),
    endToEndLatency: latency(stats.latency.end_to_end),
    volume: volume(stats.buckets, range, zone, unit),
    previousVolume: volume(stats.previous_buckets, previousRange, zone, unit),
    domains: domainRows,
    bounceReasons: reasons,
    conditions,
    everSent,
    everSentLive,
    reputation: { standing: reputation.standing, attention: reputation.attention, reason: standingReason(reputation), lines: reputation.lines },
  };
}
