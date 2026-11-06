/** A domain's last day against the two weeks before it. See docs/decisions.md. */

/** Days of baseline, each the same 24 hours of the day as the last one. */
export const BASELINE_DAYS = 14;

/** Below this average a day, a change in volume is noise. */
export const MIN_DAILY_AVERAGE = 50;

/** Baseline days with any mail. Fewer and the domain is too new, or too sporadic, to have a normal. */
export const MIN_ACTIVE_DAYS = 10;

/** The last day under this share of the average reads as down. */
export const DOWN_SHARE = 0.25;

/** The last day over this multiple of the average reads as up. */
export const UP_MULTIPLE = 3;

export type VolumeShift = "stopped" | "down" | "up";

export interface VolumeReading {
  shift: VolumeShift;
  /** Mean messages a day across the baseline. */
  average: number;
}

/**
 * Whether the last day is outside what the baseline looked like. A shift has to clear the share or
 * multiple of the average and also fall outside every baseline day, so a weekly lull doesn't count.
 */
export function readVolumeShift(lastDay: number, baseline: number[]): VolumeReading | null {
  if (baseline.length < BASELINE_DAYS) return null;
  const days = baseline.slice(0, BASELINE_DAYS);
  if (days.filter((count) => count > 0).length < MIN_ACTIVE_DAYS) return null;
  const average = days.reduce((sum, count) => sum + count, 0) / days.length;
  if (average < MIN_DAILY_AVERAGE) return null;

  if (lastDay < average * DOWN_SHARE && lastDay < Math.min(...days)) {
    return { shift: lastDay === 0 ? "stopped" : "down", average };
  }
  if (lastDay > average * UP_MULTIPLE && lastDay > Math.max(...days)) return { shift: "up", average };
  return null;
}

/** "about 300": two significant figures, so the average doesn't read as exact. */
export function roughly(value: number): number {
  if (value < 100) return Math.round(value);
  const scale = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Math.round(value / scale) * scale;
}
