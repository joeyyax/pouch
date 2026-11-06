/** Folds `GET /v1/stats`'s UTC hours into the viewer's days or hours, keyed like `bucketsIn` and `localDay`. */
import { dbNow } from "@/lib/db/clock";
import { zonedParts } from "@/lib/time-zone";
import type { BucketUnit } from "@/lib/metrics/window";
import type { StatsBucket, StatusCounts } from "@/lib/stats";

/** The end of a window that's open: past `now` and the database's clock, which stamped `created_at`. */
export async function openEnd(now: Date): Promise<Date> {
  return new Date(Math.max(now.getTime(), (await dbNow()).getTime()) + 1);
}

/** `YYYY-MM-DD`, or `YYYY-MM-DD HH`, of `at` in `zone`. A half-hour zone files each UTC hour under the local hour it starts in. */
export function localKey(at: Date, zone: string, unit: BucketUnit): string {
  const { year, month, day, hour } = zonedParts(at, zone);
  return unit === "day" ? `${year}-${month}-${day}` : `${year}-${month}-${day} ${hour}`;
}

function keysFor(starts: string[], zone: string, unit: BucketUnit): string[] {
  return starts.map((start) => localKey(new Date(start), zone, unit));
}

/** Hourly totals, summed per local bucket. */
export function foldTotals(starts: string[], totals: number[], zone: string, unit: BucketUnit): Map<string, number> {
  const keys = keysFor(starts, zone, unit);
  const folded = new Map<string, number>();
  totals.forEach((total, index) => {
    if (total === 0) return;
    const key = keys[index]!;
    folded.set(key, (folded.get(key) ?? 0) + total);
  });
  return folded;
}

/** Hourly buckets, their counts summed per local bucket. */
export function foldBuckets(buckets: StatsBucket[], zone: string, unit: BucketUnit): Map<string, StatusCounts> {
  const folded = new Map<string, StatusCounts>();
  for (const { start, ...counts } of buckets) {
    if (counts.total === 0) continue;
    const key = localKey(new Date(start), zone, unit);
    const into = folded.get(key);
    if (!into) {
      folded.set(key, { ...counts });
      continue;
    }
    for (const name of Object.keys(counts) as (keyof StatusCounts)[]) into[name] += counts[name];
  }
  return folded;
}
