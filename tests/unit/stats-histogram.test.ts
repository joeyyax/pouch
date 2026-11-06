import { describe, expect, it } from "vitest";
import { bucketOf, histogramCount, mergeHistogram, quantile, type LatencyHistogram } from "@/lib/stats/histogram";

function histogramOf(values: number[]): LatencyHistogram | null {
  let histogram: LatencyHistogram | null = null;
  for (const value of values) {
    histogram = mergeHistogram(histogram, { counts: { [String(bucketOf(value))]: 1 }, min: value, max: value });
  }
  return histogram;
}

/** `percentile_cont`, for comparison. */
function exact(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = q * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

describe("latency histograms", () => {
  it("land within a bucket's width of percentile_cont", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const values = Array.from({ length: 5000 }, () => Math.exp(random() * 12));
    const histogram = histogramOf(values);
    for (const q of [0.5, 0.95, 0.99]) {
      const want = exact(values, q);
      expect(Math.abs(quantile(histogram, q)! - want) / want).toBeLessThan(0.022);
    }
  });

  it("interpolate across a gap between samples, as percentile_cont does", () => {
    const values = [100, 220, 310, 480, 900_000];
    const histogram = histogramOf(values);
    for (const q of [0.5, 0.95, 0.99]) {
      const want = exact(values, q);
      expect(Math.abs(quantile(histogram, q)! - want) / want).toBeLessThan(0.022);
    }
  });

  it("are exact when every sample is the same", () => {
    const histogram = histogramOf(Array.from({ length: 40 }, () => 500));
    expect(quantile(histogram, 0.5)).toBe(500);
    expect(quantile(histogram, 0.99)).toBe(500);
  });

  it("add up across hours to what one histogram of every sample holds", () => {
    const morning = histogramOf([3, 40, 900]);
    const evening = histogramOf([12_000, 2]);
    const both = mergeHistogram(mergeHistogram(null, morning), evening);
    expect(both).toEqual(histogramOf([3, 40, 900, 12_000, 2]));
    expect(histogramCount(both)).toBe(5);
  });

  it("have nothing to say without samples", () => {
    expect(quantile(null, 0.5)).toBeNull();
    expect(histogramCount(null)).toBe(0);
  });

  it("put anything under a millisecond in one bucket", () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(0.4)).toBe(0);
    expect(bucketOf(1)).toBe(1);
  });
});
