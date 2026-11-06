/**
 * Latency histograms that add up across hours. Bucket 0 is under 1ms; bucket `b` above it holds
 * [2^((b-1)/32), 2^(b/32)) ms, about 2.2% wide.
 */
import { sql, type SQL } from "drizzle-orm";
import type { LatencyHistogram } from "@/lib/db/schema/message-hourly-stats";

export type { LatencyHistogram };

const STEPS_PER_DOUBLING = 32;

/** The bucket `ms` falls in, as SQL over a float expression in milliseconds. */
export function bucketSql(ms: SQL): SQL<number> {
  return sql<number>`case when ${ms} < 1 then 0 else 1 + floor(${sql.raw(String(STEPS_PER_DOUBLING))} * ln((${ms})::float8) / ln(2))::int end`;
}

/** The same bucket, computed here. */
export function bucketOf(ms: number): number {
  if (ms < 1) return 0;
  return 1 + Math.floor(STEPS_PER_DOUBLING * Math.log2(ms));
}

function lowerBound(bucket: number): number {
  return bucket === 0 ? 0 : 2 ** ((bucket - 1) / STEPS_PER_DOUBLING);
}

function upperBound(bucket: number): number {
  return 2 ** (bucket / STEPS_PER_DOUBLING);
}

/** Adds `next` into `into`, which may be null for an empty one. */
export function mergeHistogram(into: LatencyHistogram | null, next: LatencyHistogram | null): LatencyHistogram | null {
  if (!next) return into;
  if (!into) return { counts: { ...next.counts }, min: next.min, max: next.max };
  for (const [bucket, count] of Object.entries(next.counts)) into.counts[bucket] = (into.counts[bucket] ?? 0) + count;
  into.min = Math.min(into.min, next.min);
  into.max = Math.max(into.max, next.max);
  return into;
}

export function histogramCount(histogram: LatencyHistogram | null): number {
  if (!histogram) return 0;
  let total = 0;
  for (const count of Object.values(histogram.counts)) total += count;
  return total;
}

/** The `index`th smallest sample, spread evenly across its bucket and held to the exact min and max. */
function sampleAt(histogram: LatencyHistogram, buckets: (readonly [number, number])[], index: number): number {
  let before = 0;
  for (const [bucket, count] of buckets) {
    if (index < before + count) {
      const low = Math.max(lowerBound(bucket), histogram.min);
      const high = Math.min(upperBound(bucket), histogram.max);
      if (high <= low) return low;
      return count === 1 ? (low + high) / 2 : low + ((high - low) * (index - before)) / (count - 1);
    }
    before += count;
  }
  return histogram.max;
}

/**
 * The `q` quantile as `percentile_cont` takes it: the samples either side of rank `q * (n - 1)`,
 * interpolated. Each sample is placed within its bucket, so the answer is within 2.2% of exact.
 */
export function quantile(histogram: LatencyHistogram | null, q: number): number | null {
  const n = histogramCount(histogram);
  if (!histogram || n === 0) return null;
  const buckets = Object.entries(histogram.counts)
    .map(([bucket, count]) => [Number(bucket), count] as const)
    .sort((a, b) => a[0] - b[0]);
  const rank = q * (n - 1);
  const below = sampleAt(histogram, buckets, Math.floor(rank));
  const above = sampleAt(histogram, buckets, Math.ceil(rank));
  return below + (above - below) * (rank - Math.floor(rank));
}
