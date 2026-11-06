/** The behavior signals' database edge: what they count and the one counter they write. */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messages, recipientHistory, suppressedRejections } from "@/lib/db/schema";
import { readDeliveryShifts } from "@/lib/stats/delivery-time";
import { readOutcomes } from "@/lib/stats/outcomes";
import { BASELINE_DAYS, SIGNAL_WINDOW_HOURS, type BehaviorSignals } from "./standing";

const HOUR_MS = 60 * 60 * 1000;

/** Counts one refused send against its domain's current hour. */
export async function recordSuppressedRejection(organizationId: string, domainId: string): Promise<void> {
  await db
    .insert(suppressedRejections)
    .values({ organizationId, domainId, hour: sql`date_trunc('hour', now())`, count: 1 })
    .onConflictDoUpdate({
      target: [suppressedRejections.domainId, suppressedRejections.hour],
      set: { count: sql`${suppressedRejections.count} + 1` },
    });
}

/** Drops hours older than any signal window reads. */
export async function pruneSuppressedRejections(now: Date): Promise<void> {
  await db.delete(suppressedRejections).where(lt(suppressedRejections.hour, new Date(now.getTime() - 2 * SIGNAL_WINDOW_HOURS * HOUR_MS)));
}

/** Signals for every domain in an organization, or the ones named. */
export async function readSignals(organizationId: string, now: Date, domainIds?: string[]): Promise<Map<string, BehaviorSignals>> {
  const since = new Date(now.getTime() - SIGNAL_WINDOW_HOURS * HOUR_MS);
  const baselineSince = new Date(since.getTime() - BASELINE_DAYS * 24 * HOUR_MS);
  const scoped = domainIds ? [inArray(domains.id, domainIds)] : [];

  const [domainRows, volume, recipients, rejections, deliveryShifts] = await Promise.all([
    db
      .select({ id: domains.id, verifiedAt: domains.verifiedAt })
      .from(domains)
      .where(and(eq(domains.organizationId, organizationId), ...scoped)),
    Promise.all([
      readOutcomes({ organizationId, domainIds }, since, now, now),
      readOutcomes({ organizationId, domainIds }, baselineSince, since, now),
    ]),
    // First seen is organization-wide: an address another domain already mailed isn't new.
    db.execute<{ domain_id: string; recipients: number; first_time: number }>(sql`
      select m.domain_id,
             count(distinct r.address)::int as recipients,
             count(distinct r.address) filter (where h.first_seen_at >= ${since.toISOString()}::timestamptz)::int as first_time
      from ${messages} m
      cross join lateral unnest(m.recipients) as r(address)
      left join ${recipientHistory} h on h.organization_id = m.organization_id and h.address = r.address
      where m.organization_id = ${organizationId}
        and m.test_mode = false
        and m.created_at >= ${since.toISOString()}::timestamptz
        and m.created_at < ${now.toISOString()}::timestamptz
        ${domainIds ? sql`and m.domain_id in (${sql.join(domainIds.map((id) => sql`${id}`), sql`, `)})` : sql``}
      group by m.domain_id
    `),
    db
      .select({ domainId: suppressedRejections.domainId, count: sql<number>`sum(${suppressedRejections.count})::int` })
      .from(suppressedRejections)
      .where(
        and(
          eq(suppressedRejections.organizationId, organizationId),
          gte(suppressedRejections.hour, new Date(since.getTime() - (since.getTime() % HOUR_MS))),
        ),
      )
      .groupBy(suppressedRejections.domainId),
    readDeliveryShifts({ organizationId, domainIds }, now),
  ]);

  const [recent, baseline] = volume;
  const recipientsBy = new Map(recipients.map((row) => [row.domain_id, row]));
  const rejectionsBy = new Map(rejections.map((row) => [row.domainId, row.count]));

  return new Map(
    domainRows.map((domain) => [
      domain.id,
      {
        recentTotal: recent.get(domain.id)?.total ?? 0,
        baselineTotal: baseline.get(domain.id)?.total ?? 0,
        recentRecipients: Number(recipientsBy.get(domain.id)?.recipients ?? 0),
        firstTimeRecipients: Number(recipientsBy.get(domain.id)?.first_time ?? 0),
        suppressedRejections: rejectionsBy.get(domain.id) ?? 0,
        deliveryTime: deliveryShifts.get(domain.id) ?? null,
        verifiedAt: domain.verifiedAt,
        now,
      },
    ]),
  );
}
