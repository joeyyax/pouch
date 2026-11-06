/** A domain's p90 delivery time against its own earlier weeks. See docs/decisions.md. */
import { spellDuration } from "./duration";

/** Days in each `domain_daily_stats` delivery window. */
export const DELIVERY_WINDOW_DAYS = 7;

/** The latest p90 over this multiple of normal reads as slow. */
export const SLOW_MULTIPLE = 3;

/** Under this p90 a rise is noise, however large the multiple. */
export const SLOW_FLOOR_MS = 30_000;

/** Delivered messages a window needs before its p90 counts. */
export const MIN_DELIVERED = 100;

/** Baseline rows, of the 8 days of non-overlapping windows, that need that volume. */
export const MIN_BASELINE_ROWS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DeliveryTimeRow {
  /** `2026-10-01`, the UTC day of the run. */
  day: string;
  deliveredCount: number;
  p90Ms: number | null;
}

export interface DeliveryShift {
  /** The latest window's p90. */
  p90Ms: number;
  /** The median p90 of the windows that end before the latest one starts. */
  baselineMs: number;
  /** Delivered messages behind the latest p90. */
  delivered: number;
}

function dayOffset(day: string, offset: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Whether today's p90 is well above the domain's normal. Each row's window covers the 7 days to
 * its run, so the baseline is the rows from 7 to 14 days back, whose windows end before today's
 * begins. It needs both a multiple and an absolute floor, and enough history and volume on both sides.
 */
export function readDeliveryShift(rows: DeliveryTimeRow[], now: Date): DeliveryShift | null {
  const today = now.toISOString().slice(0, 10);
  const latest = rows.find((row) => row.day === today);
  if (!latest || latest.p90Ms === null || latest.deliveredCount < MIN_DELIVERED) return null;

  const oldest = dayOffset(today, -2 * DELIVERY_WINDOW_DAYS);
  const newest = dayOffset(today, -DELIVERY_WINDOW_DAYS);
  const baseline = rows.flatMap((row) =>
    row.day >= oldest && row.day <= newest && row.p90Ms !== null && row.deliveredCount >= MIN_DELIVERED ? [row.p90Ms] : [],
  );
  if (baseline.length < MIN_BASELINE_ROWS) return null;

  const baselineMs = median(baseline);
  if (latest.p90Ms < SLOW_FLOOR_MS || latest.p90Ms < baselineMs * SLOW_MULTIPLE) return null;
  return { p90Ms: latest.p90Ms, baselineMs, delivered: latest.deliveredCount };
}

/** "4 minutes, against 40 seconds the 7 days before": the numbers a sentence about a slow domain carries. */
export function describeDeliveryShift(shift: DeliveryShift): string {
  return `${spellDuration(shift.p90Ms)}, against ${spellDuration(shift.baselineMs)} the ${DELIVERY_WINDOW_DAYS} days before`;
}

/** How many times normal, rounded down. */
export function shiftMultiple(shift: DeliveryShift): number {
  return Math.floor(shift.p90Ms / shift.baselineMs);
}
