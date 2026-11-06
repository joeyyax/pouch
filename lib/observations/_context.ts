import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { BASELINE_DAYS } from "@/lib/metrics/volume";
import { ceilHour, HOUR_MS } from "@/lib/stats/cells";
import type { ObservationContext, TagVolume } from "./_types";

const DAY_MS = 24 * HOUR_MS;

/**
 * Live sends per tag in 24-hour slices ending on the hour after `now`, the slices
 * `readDomainVolumes` uses for domains, with the domains that carried each tag in the baseline
 * and whether each sent any live mail in the last day. Rides `messages_live_tagged_idx`.
 */
export async function readTagVolumes(organizationId: string, now: Date, days = BASELINE_DAYS): Promise<TagVolume[]> {
  const end = ceilHour(new Date(now.getTime() + 1));
  const since = new Date(end.getTime() - (days + 1) * DAY_MS);
  const lastDayStart = new Date(end.getTime() - DAY_MS);
  const rows = await db.execute<{ tag: string; domain_id: string; slice: number; count: number; domain_sending: boolean }>(sql`
    with tagged as (
      select t.tag, m.domain_id, floor((extract(epoch from (${end.toISOString()}::timestamptz - m.created_at)) * 1000 - 1) / ${DAY_MS})::int as slice, count(*)::int as count
      from messages m cross join lateral unnest(m.tags) as t(tag)
      where m.organization_id = ${organizationId}
        and m.test_mode = false
        and cardinality(m.tags) > 0
        and m.created_at >= ${since.toISOString()}::timestamptz
        and m.created_at < ${end.toISOString()}::timestamptz
      group by 1, 2, 3
    ),
    sending as (
      select distinct m.domain_id
      from messages m
      where m.organization_id = ${organizationId}
        and m.test_mode = false
        and m.created_at >= ${lastDayStart.toISOString()}::timestamptz
        and m.created_at < ${end.toISOString()}::timestamptz
    )
    select tagged.*, sending.domain_id is not null as domain_sending
    from tagged left join sending on sending.domain_id = tagged.domain_id
  `);

  const volumes = new Map<string, { counts: number[]; domains: Map<string, boolean> }>();
  for (const row of rows) {
    if (row.slice < 0 || row.slice > days) continue;
    const volume = volumes.get(row.tag) ?? { counts: new Array<number>(days + 1).fill(0), domains: new Map<string, boolean>() };
    volume.counts[row.slice]! += row.count;
    if (row.slice > 0) volume.domains.set(row.domain_id, row.domain_sending);
    volumes.set(row.tag, volume);
  }
  return [...volumes].map(([tag, { counts: [lastDay = 0, ...baseline], domains }]) => ({
    tag,
    lastDay,
    baseline,
    baselineDomains: [...domains].map(([domainId, sending]) => ({ domainId, sending })),
  }));
}

/** The context one observation runs with. Shared reads are memoized across the run. */
export function contextFactory(organizationId: string, now: Date) {
  let tagVolumes: Promise<TagVolume[]> | null = null;
  return (mutes: ObservationContext["mutes"]): ObservationContext => ({
    organizationId,
    now,
    mutes,
    tagVolumes: () => (tagVolumes ??= readTagVolumes(organizationId, now)),
  });
}
