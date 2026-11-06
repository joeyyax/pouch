import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domainDailyStats, domains, messages } from "@/lib/db/schema";
import type { DomainDailyStatsRow } from "@/lib/db/schema";
import { DELIVERY_WINDOW_DAYS } from "@/lib/metrics/delivery-time";

const DAY_MS = 24 * 60 * 60 * 1000;

export const VOLUME_WINDOW_DAYS = 28;
export const STATS_KEPT_DAYS = 90;
const UPSERT_CHUNK = 500;

/** The quantiles each row stores, in column order. */
const QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9, 0.99] as const;

/** `2026-10-01`, the UTC day `at` falls on. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Sent in [since, until), test mode left out. `messages_sent_at_idx` covers the range. */
function sentBetween(since: Date, until: Date) {
  return and(gte(messages.sentAt, since), lt(messages.sentAt, until), eq(messages.testMode, false));
}

/**
 * Recomputes every domain's rolling windows ending at `now` and upserts the row for `now`'s UTC
 * day. One grouped query per stat across all domains. Domains with nothing sent in 28 days get no row.
 */
export async function computeDomainStats(now: Date): Promise<number> {
  const day = utcDay(now);
  const deliveryStart = new Date(now.getTime() - DELIVERY_WINDOW_DAYS * DAY_MS);
  const volumeStart = new Date(now.getTime() - VOLUME_WINDOW_DAYS * DAY_MS);

  const elapsed = sql`least(extract(epoch from (${messages.deliveredAt} - ${messages.sentAt})) * 1000, 2147483647)`;
  const quantiles = sql.raw(`array[${QUANTILES.join(", ")}]`);
  const delivery = await db
    .select({
      domainId: messages.domainId,
      count: sql<number>`count(*)::int`,
      min: sql<number>`round(min(${elapsed}))::int`,
      quantiles: sql<number[]>`(percentile_cont(${quantiles}) within group (order by ${elapsed}))::int[]`,
      max: sql<number>`round(max(${elapsed}))::int`,
    })
    .from(messages)
    .where(
      and(
        sentBetween(deliveryStart, now),
        isNotNull(messages.deliveredAt),
        // A negative elapsed means the clocks disagreed, not that a message arrived before it left.
        sql`${messages.deliveredAt} >= ${messages.sentAt}`,
      ),
    )
    .groupBy(messages.domainId);

  const volume = await db
    .select({
      domainId: messages.domainId,
      organizationId: domains.organizationId,
      hour: sql<number>`extract(hour from ${messages.sentAt} at time zone 'UTC')::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(messages)
    // The domain's organization, so the service's own mail counts toward the domain that sent it.
    .innerJoin(domains, eq(domains.id, messages.domainId))
    .where(sentBetween(volumeStart, now))
    .groupBy(messages.domainId, domains.organizationId, sql`3`);

  const latencyByDomain = new Map(delivery.map((row) => [row.domainId, row]));
  const byDomain = new Map<string, { organizationId: string; hourlyVolume: number[] }>();
  for (const row of volume) {
    const entry = byDomain.get(row.domainId) ?? {
      organizationId: row.organizationId,
      hourlyVolume: Array.from({ length: 24 }, () => 0),
    };
    entry.hourlyVolume[row.hour] = row.count;
    byDomain.set(row.domainId, entry);
  }

  const rows = [...byDomain].map(([domainId, { organizationId, hourlyVolume }]) => {
    const latency = latencyByDomain.get(domainId);
    const [p10, p25, p50, p75, p90, p99] = latency?.quantiles ?? [];
    return {
      organizationId,
      domainId,
      day,
      computedAt: now,
      deliveryWindowStart: deliveryStart,
      deliveredCount: latency?.count ?? 0,
      deliveryMinMs: latency?.min ?? null,
      deliveryP10Ms: p10 ?? null,
      deliveryP25Ms: p25 ?? null,
      deliveryP50Ms: p50 ?? null,
      deliveryP75Ms: p75 ?? null,
      deliveryP90Ms: p90 ?? null,
      deliveryP99Ms: p99 ?? null,
      deliveryMaxMs: latency?.max ?? null,
      volumeWindowStart: volumeStart,
      hourlyVolume,
    };
  });

  for (let start = 0; start < rows.length; start += UPSERT_CHUNK) {
    await db
      .insert(domainDailyStats)
      .values(rows.slice(start, start + UPSERT_CHUNK))
      .onConflictDoUpdate({
        target: [domainDailyStats.domainId, domainDailyStats.day],
        set: {
          computedAt: sql`excluded.computed_at`,
          deliveryWindowStart: sql`excluded.delivery_window_start`,
          deliveredCount: sql`excluded.delivered_count`,
          deliveryMinMs: sql`excluded.delivery_min_ms`,
          deliveryP10Ms: sql`excluded.delivery_p10_ms`,
          deliveryP25Ms: sql`excluded.delivery_p25_ms`,
          deliveryP50Ms: sql`excluded.delivery_p50_ms`,
          deliveryP75Ms: sql`excluded.delivery_p75_ms`,
          deliveryP90Ms: sql`excluded.delivery_p90_ms`,
          deliveryP99Ms: sql`excluded.delivery_p99_ms`,
          deliveryMaxMs: sql`excluded.delivery_max_ms`,
          volumeWindowStart: sql`excluded.volume_window_start`,
          hourlyVolume: sql`excluded.hourly_volume`,
        },
      });
  }

  return rows.length;
}

/** Deletes rows from more than `STATS_KEPT_DAYS` before `now`'s UTC day. */
export async function pruneDomainStats(now: Date): Promise<number> {
  const cutoff = utcDay(new Date(now.getTime() - STATS_KEPT_DAYS * DAY_MS));
  const deleted = await db
    .delete(domainDailyStats)
    .where(lt(domainDailyStats.day, cutoff))
    .returning({ domainId: domainDailyStats.domainId });
  return deleted.length;
}

/** The newest row for a domain in this organization, or null. */
export async function latestDomainStats(organizationId: string, domainId: string): Promise<DomainDailyStatsRow | null> {
  const [row] = await db
    .select()
    .from(domainDailyStats)
    .where(and(eq(domainDailyStats.domainId, domainId), eq(domainDailyStats.organizationId, organizationId)))
    .orderBy(desc(domainDailyStats.day))
    .limit(1);
  return row ?? null;
}
