import { and, arrayContains, arrayOverlaps, asc, eq, gt, gte, ilike, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messages } from "@/lib/db/schema";
import { normalizeAddress } from "@/lib/addresses";
import { heldCondition } from "@/lib/messages/held";
import { bounceReasonCondition } from "@/lib/messages/reason";
import { LIST_WINDOW_DAYS } from "@/lib/dashboard/views/messages";
import { fillDays, type DayCount } from "@/lib/dashboard/views/days";
import { localDay } from "@/lib/dashboard/local-day";
import type { MessageFilters } from "@/lib/messages/filters";
import { ApiError } from "@/lib/api/errors";
import { selectShape } from "@/lib/api/shape";
import { statsShape } from "@/lib/schemas/stats";
import { readStats, type StatsResponse } from "@/lib/stats";
import { foldBuckets, openEnd } from "@/lib/dashboard/local-buckets";

export function listWindowStart(since: Date | undefined, now: Date = new Date()): Date {
  return since ?? new Date(now.getTime() - LIST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/** A sent-only list counts its window from the send, the time the overview's silent-send alert counts from. */
export function windowColumn(filters: MessageFilters) {
  return filters.statuses?.length === 1 && filters.statuses[0] === "sent" ? messages.sentAt : messages.createdAt;
}

/**
 * The messages list's `where`, over `messages` inner-joined to `domains`. The list, its volume strip and the
 * exports share it. `createdWindow` swaps the screen's window rules for the API's: `since` and `until` bound
 * `created_at`, open-ended when unset.
 */
export function messageListConditions(
  organizationId: string,
  filters: MessageFilters,
  now: Date = new Date(),
  { createdWindow = false }: { createdWindow?: boolean } = {},
) {
  const search = filters.search?.trim();
  const address = filters.address ? normalizeAddress(filters.address) : undefined;

  const column = createdWindow ? messages.createdAt : windowColumn(filters);

  return and(
    eq(messages.organizationId, organizationId),
    createdWindow
      ? filters.since
        ? gte(column, filters.since)
        : undefined
      : gte(column, listWindowStart(filters.since, now)),
    filters.until ? lte(column, filters.until) : undefined,
    filters.domain ? eq(domains.name, filters.domain) : undefined,
    filters.domainId ? eq(messages.domainId, filters.domainId) : undefined,
    filters.restrictToDomainIds && filters.restrictToDomainIds.length > 0
      ? inArray(messages.domainId, filters.restrictToDomainIds)
      : undefined,
    filters.keyId ? eq(messages.apiKeyId, filters.keyId) : undefined,
    filters.batchId ? eq(messages.batchId, filters.batchId) : undefined,
    filters.statuses && filters.statuses.length > 0 ? inArray(messages.status, filters.statuses) : undefined,
    filters.held ? heldCondition() : undefined,
    filters.retried ? gt(messages.attempts, 1) : undefined,
    filters.sensitive ? isNotNull(messages.bodyWithheld) : undefined,
    filters.reason ? bounceReasonCondition(filters.reason) : undefined,
    filters.tags && filters.tags.length > 0 ? arrayOverlaps(messages.tags, filters.tags) : undefined,
    address ? arrayContains(messages.recipients, [address]) : undefined,
    search
      ? or(
          eq(messages.id, search),
          ilike(messages.subject, `%${search}%`),
          sql`exists (select 1 from unnest(${messages.recipients}) as recipient where recipient ilike ${`%${search}%`})`,
          filters.fuzzyIds && filters.fuzzyIds.length > 0 ? inArray(messages.id, filters.fuzzyIds) : undefined,
        )
      : undefined,
  );
}

function dayCount(day: string, counts: { total: number; bounced: number; complained: number; failed: number }): DayCount {
  const breakdown = (
    [
      ["bounced", counts.bounced],
      ["complained", counts.complained],
      ["failed", counts.failed],
    ] as [string, number][]
  ).filter(([, count]) => count > 0);
  return { day, total: counts.total, flagged: counts.bounced + counts.complained + counts.failed, breakdown };
}

/** `GET /v1/stats` counts by domain, key and status on `created_at`; anything narrower is counted live. */
function statsAnswers(filters: MessageFilters): boolean {
  return (
    windowColumn(filters) === messages.createdAt &&
    !filters.search &&
    !filters.fuzzyIds?.length &&
    !filters.tags?.length &&
    !filters.address &&
    !filters.batchId &&
    !filters.held &&
    !filters.retried &&
    !filters.sensitive &&
    !filters.reason
  );
}

const VOLUME_SELECTION = selectShape(statsShape, { fields: ["buckets"] });

async function statsVolume(organizationId: string, filters: MessageFilters, zone: string, now: Date): Promise<DayCount[]> {
  const since = listWindowStart(filters.since, now);
  // The list's `until` is inclusive and its default is open.
  const until = filters.until ? new Date(filters.until.getTime() + 1) : await openEnd(now);
  let domainId = filters.domainId;
  if (filters.domain) {
    const [row] = await db
      .select({ id: domains.id })
      .from(domains)
      .where(and(eq(domains.organizationId, organizationId), eq(domains.name, filters.domain)))
      .limit(1);
    if (!row || (domainId && domainId !== row.id)) return fillDays(since, now, [], zone);
    domainId = row.id;
  }
  if (until <= since) return fillDays(since, now, [], zone);

  const stats = (await readStats(
    { organizationId, domainIds: filters.restrictToDomainIds ?? [] },
    { since, until, bucket: "hour", mode: "all", domain: domainId, key: filters.keyId, status: filters.statuses },
    VOLUME_SELECTION,
    now,
  ).catch((error: unknown) => {
    // A domain or key the filter names that isn't here matches nothing, as it does in the list.
    if (error instanceof ApiError && (error.code === "not_found" || error.code === "key_not_scoped")) return { buckets: [] };
    throw error;
  })) as Pick<StatsResponse, "buckets">;
  const counts = [...foldBuckets(stats.buckets, zone, "day")].map(([day, folded]) => dayCount(day, folded));
  return fillDays(since, now, counts, zone);
}

/** Messages per day in `zone` across the list's whole window, under the list's filters. Bounced, complained and failed are flagged. */
export async function messageVolume(
  organizationId: string,
  filters: MessageFilters,
  zone: string,
  now: Date = new Date(),
): Promise<DayCount[]> {
  if (statsAnswers(filters)) return statsVolume(organizationId, filters, zone, now);

  const day = localDay(windowColumn(filters), zone);
  const rows = await db
    .select({
      day,
      total: sql<number>`count(*)::int`,
      bounced: sql<number>`count(*) filter (where ${messages.status} = 'bounced')::int`,
      complained: sql<number>`count(*) filter (where ${messages.status} = 'complained')::int`,
      failed: sql<number>`count(*) filter (where ${messages.status} = 'failed')::int`,
    })
    .from(messages)
    .innerJoin(domains, eq(domains.id, messages.domainId))
    .where(messageListConditions(organizationId, filters, now))
    .groupBy(day)
    .orderBy(asc(day));

  return fillDays(listWindowStart(filters.since, now), now, rows.map((row) => dayCount(row.day, row)), zone);
}
