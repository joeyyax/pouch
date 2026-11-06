/**
 * Counts to rates. Two rules, kept here so no call site skips them: below `RATE_FLOOR` resolved
 * messages there's no percentage, and unresolved messages never land in a denominator.
 */

/** Below this many resolved messages, show counts and no percentage. */
export const RATE_FLOOR = 50;

export interface OutcomeCounts {
  /** Everything accepted into the queue in the window. */
  total: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  /** Handed to the provider, still waiting on an outcome. Never in a denominator. */
  inFlight: number;
  /** Still in the queue, not yet handed over. */
  queued: number;
}

export const EMPTY_COUNTS: OutcomeCounts = {
  total: 0,
  delivered: 0,
  bounced: 0,
  complained: 0,
  failed: 0,
  inFlight: 0,
  queued: 0,
};

export type Outcome = "delivered" | "bounced" | "complained" | "failed";

/** Messages that reached an outcome. The denominator for every rate on the page. */
export function resolved(counts: OutcomeCounts): number {
  return counts.delivered + counts.bounced + counts.complained + counts.failed;
}

/** Fills in a full `OutcomeCounts` from just the four outcome numbers a caller has on hand. */
export function outcomeCounts(counts: Pick<OutcomeCounts, "delivered" | "bounced" | "complained" | "failed">): OutcomeCounts {
  return { ...EMPTY_COUNTS, ...counts };
}

/** The rate as a fraction, or null below the floor. The UI shows the count instead. */
export function rate(count: number, denominator: number, floor = RATE_FLOOR): number | null {
  if (denominator < floor || denominator === 0) return null;
  return count / denominator;
}

export function rateFor(counts: OutcomeCounts, outcome: Outcome, floor = RATE_FLOOR): number | null {
  return rate(counts[outcome], resolved(counts), floor);
}

/** The change between two rates, in percentage points. Null when either side is unknown. */
export function rateDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return current - previous;
}

/** Which direction is good. Delivered up is good; every other outcome up is bad. */
export function deltaTone(outcome: Outcome, delta: number | null): "muted" | "success" | "danger" {
  if (delta === null || Math.abs(delta) < 0.001) return "muted";
  const rising = delta > 0;
  const goodWhenRising = outcome === "delivered";
  return rising === goodWhenRising ? "success" : "danger";
}

/** `0.0432` → `"4.3%"`. One decimal, because the thresholds that matter sit at 5% and 0.1%. */
export function formatRate(value: number | null, digits = 1): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/** A delta in percentage points, signed. `+0.4pp`. */
export function formatRateDelta(delta: number | null, digits = 1): string | null {
  if (delta === null || Math.abs(delta) < 0.001) return null;
  const points = delta * 100;
  return `${points > 0 ? "+" : "−"}${Math.abs(points).toFixed(digits)}pp`;
}

/** Change between two counts as a fraction of the earlier one. Null when there's nothing to compare to. */
export function countDelta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}
