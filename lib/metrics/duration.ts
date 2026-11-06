/** Latency, in milliseconds, at the percentiles worth quoting. Null when nothing qualified. */
export interface Latency {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** How many messages the percentiles came from. A p99 off eleven messages isn't one. */
  count: number;
}

/** Below this many samples, a percentile is an anecdote. */
export const LATENCY_FLOOR = 20;

/** A duration at a glance, in one unit: milliseconds, seconds, minutes, hours, days. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** The same, spelled out, for a sentence rather than a stat. */
export function spellDuration(ms: number | null): string {
  if (ms === null) return "an unknown time";
  if (ms < 1000) return "under a second";
  if (ms < 60_000) {
    const seconds = Math.round(ms / 1000);
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  if (ms < 3_600_000) {
    const minutes = Math.round(ms / 60_000);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (ms < 48 * 3_600_000) {
    const hours = Math.round(ms / 3_600_000);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(ms / 86_400_000);
  return `${days} days`;
}
