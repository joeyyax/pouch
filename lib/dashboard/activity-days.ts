import { and, asc, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity } from "@/lib/db/schema";
import { scopeConditions } from "@/lib/activity/query";
import type { ActivityFilters } from "@/lib/activity/types";
import { dayKey, fillDays, type DayCount } from "@/lib/dashboard/views/days";
import { localDay } from "@/lib/dashboard/local-day";
import { addDays, startOfZonedDay } from "@/lib/time-zone";

/** How far back the chart and the filter counts reach when the URL sets no `since`. */
export const ACTIVITY_CHART_DAYS = 30;

/** Where the screen's counts start: the URL's `since`, or midnight in `zone` `ACTIVITY_CHART_DAYS` days back. */
export function activityWindowStart(filters: Pick<ActivityFilters, "since">, zone: string, now: Date = new Date()): Date {
  return filters.since ?? startOfZonedDay(addDays(dayKey(now, zone), -(ACTIVITY_CHART_DAYS - 1)), zone);
}

/** Activity per day in `zone` under the screen's filters. Failures are flagged. */
export async function activityByDay(
  organizationId: string,
  filters: ActivityFilters,
  zone: string,
  now: Date = new Date(),
): Promise<DayCount[]> {
  const since = activityWindowStart(filters, zone, now);
  const day = localDay(activity.createdAt, zone);
  const rows = await db
    .select({
      day,
      total: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${activity.outcome} = 'failure')::int`,
    })
    .from(activity)
    .where(and(...scopeConditions(organizationId, { ...filters, since: null }), gte(activity.createdAt, since)))
    .groupBy(day)
    .orderBy(asc(day));

  return fillDays(
    since,
    now,
    rows.map((row) => ({
      day: row.day,
      total: row.total,
      flagged: row.failed,
      breakdown: row.failed > 0 ? [["failed", row.failed]] : [],
    })),
    zone,
  );
}
