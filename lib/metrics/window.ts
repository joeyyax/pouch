/** The window a metrics page covers, and the equal-length window before it. */

import { addDays, calendarDate, zonedDayKey, zonedParts } from "@/lib/time-zone";

export const METRICS_WINDOWS = [1, 7, 30, 90] as const;

/** The window the delivered and bounce columns cover, on the domain list and the system view. */
export const RATE_WINDOW_DAYS = 7;

export type MetricsWindowDays = (typeof METRICS_WINDOWS)[number];

export const DEFAULT_WINDOW_DAYS: MetricsWindowDays = 30;

const DAY_MS = 86_400_000;

export interface MetricsRange {
  days: MetricsWindowDays;
  since: Date;
  until: Date;
  previousSince: Date;
  /** The previous window ends where this one starts. */
  previousUntil: Date;
}

export function metricsRange(days: MetricsWindowDays, now = new Date()): MetricsRange {
  const until = now;
  const since = new Date(until.getTime() - days * DAY_MS);
  return {
    days,
    since,
    until,
    previousSince: new Date(since.getTime() - days * DAY_MS),
    previousUntil: since,
  };
}

/** Reads the window off a query string, falling back rather than rejecting an unknown value. */
export function readWindowDays(value: string | undefined): MetricsWindowDays {
  const parsed = Number(value);
  return (METRICS_WINDOWS as readonly number[]).includes(parsed)
    ? (parsed as MetricsWindowDays)
    : DEFAULT_WINDOW_DAYS;
}

/**
 * Every day the range touches in `zone`, oldest first, so a chart has a bar for a day nothing was
 * sent. Each is that calendar day's UTC midnight, the shape `localDay` keys match.
 */
export function daysIn(range: MetricsRange, zone: string): Date[] {
  const days: Date[] = [];
  const end = zonedDayKey(range.until, zone);
  for (let day = zonedDayKey(range.since, zone); day <= end; day = addDays(day, 1)) days.push(calendarDate(day));
  return days;
}

/** Hourly buckets for the one-day window, daily otherwise. */
export type BucketUnit = "hour" | "day";

export function bucketUnit(days: MetricsWindowDays): BucketUnit {
  return days === 1 ? "hour" : "day";
}

/** "24 hours" or "30 days", for copy that names the window. */
export function windowLabel(days: MetricsWindowDays): string {
  return days === 1 ? "24 hours" : `${days} days`;
}

export interface Bucket {
  /** The bucket's start: a calendar day's UTC midnight, or an hour's instant. */
  date: Date;
  /** What `localBucket` groups by: `YYYY-MM-DD`, or `YYYY-MM-DD HH` for an hour. */
  key: string;
  /** `09-24`, or `14:00` for an hour. */
  label: string;
}

const HOUR_MS = 3_600_000;

/** Every bucket the range touches in `zone`, oldest first, so a chart has a bar for an empty one. */
export function bucketsIn(range: MetricsRange, zone: string, unit: BucketUnit): Bucket[] {
  if (unit === "day") return daysIn(range, zone).map((date) => ({ date, key: date.toISOString().slice(0, 10), label: date.toISOString().slice(5, 10) }));
  const buckets: Bucket[] = [];
  const seen = new Set<string>();
  const end = range.until.getTime();
  for (let at = Math.floor(range.since.getTime() / HOUR_MS) * HOUR_MS; at <= end; at += HOUR_MS) {
    const { year, month, day, hour } = zonedParts(new Date(at), zone);
    const key = `${year}-${month}-${day} ${hour}`;
    if (seen.has(key)) continue;
    seen.add(key);
    buckets.push({ date: new Date(at), key, label: `${hour}:00` });
  }
  return buckets;
}
