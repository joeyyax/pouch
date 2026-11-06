/**
 * Day buckets for time-ordered screens, in the viewer's zone. A day is a `YYYY-MM-DD` key.
 */

import { addDays, zonedDayKey } from "@/lib/time-zone";

/** One bar of a daily strip. `flagged` is the part of `total` that went wrong. */
export interface DayCount {
  /** `2026-09-28`. */
  day: string;
  total: number;
  flagged: number;
  /** Named parts of `flagged`, for the hover: `[["bounced", 2], ["failed", 1]]`. */
  breakdown?: [label: string, count: number][];
}

/** `2026-09-28`, the day `date` falls on in `zone`. */
export function dayKey(date: Date, zone: string): string {
  return zonedDayKey(date, zone);
}

/** Every day from `since` through `now` in `zone`, oldest first, with the counts that exist and zeros for the rest. */
export function fillDays(since: Date, now: Date, counts: DayCount[], zone: string): DayCount[] {
  const byDay = new Map(counts.map((count) => [count.day, count]));
  const end = dayKey(now, zone);
  const days: DayCount[] = [];
  for (let day = dayKey(since, zone); day <= end; day = addDays(day, 1)) {
    days.push(byDay.get(day) ?? { day, total: 0, flagged: 0 });
  }
  return days;
}

const LONG = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
const LONG_YEAR = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
const SHORT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

/** "Today", "Yesterday", "Monday, September 28", or "September 28, 2025" outside this year, with today in `zone`. */
export function dayHeading(day: string, zone: string, now: Date = new Date()): string {
  const today = dayKey(now, zone);
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  const date = new Date(`${day}T00:00:00.000Z`);
  return day.slice(0, 4) === today.slice(0, 4) ? LONG.format(date) : LONG_YEAR.format(date);
}

/** "Sep 28", for axis ends and hovers. */
export function shortDay(day: string): string {
  return SHORT.format(new Date(`${day}T00:00:00.000Z`));
}

/** Splits a newest-first list into runs that share a day in `zone`. Order is kept. */
export function groupByDay<T>(items: T[], dateOf: (item: T) => Date, zone: string): { day: string; items: T[] }[] {
  const groups: { day: string; items: T[] }[] = [];
  for (const item of items) {
    const day = dayKey(dateOf(item), zone);
    const last = groups.at(-1);
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}
