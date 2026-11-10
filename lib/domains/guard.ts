import { RATE_FLOOR, formatRate, rate, rateDelta, resolved, type OutcomeCounts } from "@/lib/metrics/rates";
import { SETTINGS } from "@/lib/settings/registry";

/**
 * Decides whether a domain's queue should stall — stop releasing sends, keep accepting them —
 * before its bounce or complaint rate gets the provider account reviewed or paused.
 *
 * The stall lines are ours, not the provider's: AWS SES reviews a provider at 5% bounce or
 * 0.1% complaint and pauses it at 10%/0.5%. Acting at half the review line means we've stalled
 * and started looking before AWS does. They're registry settings that only tighten, read
 * through `readStallLines` (`lib/domains/stall.ts`).
 */

/** Where a provider puts a sender under review. Theirs, not ours — these are SES's numbers. */
export const PROVIDER_REVIEW_BOUNCE_RATE = 0.05;
export const PROVIDER_REVIEW_COMPLAINT_RATE = 0.001;

/** Where a provider pauses sending. SES's numbers. */
export const PROVIDER_PAUSE_BOUNCE_RATE = 0.1;
export const PROVIDER_PAUSE_COMPLAINT_RATE = 0.005;

/** One complaint is the least a count can be, so it isn't a setting. */
export const STALL_COMPLAINT_COUNT = 1;

/** The trailing window the level and trend checks read. Short, so a spike isn't buried in 30 days of quiet. */
export const STALL_WINDOW_DAYS = 7;

export type StallMetric = "bounce" | "complaint";

export interface MetricLines {
  stall: number;
  /** Below `RATE_FLOOR` resolved messages a rate isn't meaningful, but a small absolute count still is. */
  count: number;
  providerReview: number;
  providerPause: number;
}

/** Every line the guard and standing measure against. */
export interface StallLines {
  bounce: MetricLines;
  complaint: MetricLines;
  /**
   * Below this many resolved messages, even the count guard stays quiet — 1 complaint on a
   * domain's first few sends is as likely to be one person's mistake as it is abuse, and 3
   * bounces on 4 sends is a bad address list, not a trend. Real volume, not domain age: age is
   * easy to fake by waiting, volume isn't.
   */
  countVolumeFloor: number;
}

/** The registry values the lines come from. */
export interface StallSettingValues {
  stall_bounce_percent: number;
  stall_complaint_percent: number;
  stall_bounce_count: number;
  stall_count_volume_floor: number;
}

const fraction = (percent: number) => Number((percent / 100).toPrecision(12));

export function stallLines(values: StallSettingValues): StallLines {
  return {
    bounce: {
      stall: fraction(values.stall_bounce_percent),
      count: values.stall_bounce_count,
      providerReview: PROVIDER_REVIEW_BOUNCE_RATE,
      providerPause: PROVIDER_PAUSE_BOUNCE_RATE,
    },
    complaint: {
      stall: fraction(values.stall_complaint_percent),
      count: STALL_COMPLAINT_COUNT,
      providerReview: PROVIDER_REVIEW_COMPLAINT_RATE,
      providerPause: PROVIDER_PAUSE_COMPLAINT_RATE,
    },
    countVolumeFloor: values.stall_count_volume_floor,
  };
}

/** The lines with nothing configured, which are also the loosest allowed. */
export const DEFAULT_STALL_LINES = stallLines({
  stall_bounce_percent: SETTINGS.stall_bounce_percent.default,
  stall_complaint_percent: SETTINGS.stall_complaint_percent.default,
  stall_bounce_count: SETTINGS.stall_bounce_count.default,
  stall_count_volume_floor: SETTINGS.stall_count_volume_floor.default,
});

/** Past `line` now, or rising fast enough that one more window of the same change crosses it. */
export function projectsPast(current: number | null, previous: number | null, line: number): "level" | "trend" | null {
  if (current === null) return null;
  if (current > line) return "level";
  const delta = rateDelta(current, previous);
  return delta !== null && delta > 0 && current + delta > line ? "trend" : null;
}

export type StallReason = `${StallMetric}_rate` | `${StallMetric}_trend` | `${StallMetric}_count`;

export const STALL_REASONS = [
  "bounce_rate",
  "bounce_trend",
  "bounce_count",
  "complaint_rate",
  "complaint_trend",
  "complaint_count",
] as const satisfies readonly StallReason[];

/** The numbers that tripped the guard, snapshotted so the domain row and dashboard can say why. */
export interface StallDetail {
  metric: StallMetric;
  count: number;
  denominator: number;
  /** Null below `RATE_FLOOR` — the count guard fired instead. */
  rate: number | null;
  previousRate: number | null;
  threshold: number;
}

export interface StallVerdict {
  reason: StallReason;
  detail: StallDetail;
}

export interface StallCheckInput {
  /** Current `STALL_WINDOW_DAYS`-day counts, test-mode excluded. */
  counts: OutcomeCounts;
  /** The `STALL_WINDOW_DAYS`-day window immediately before `counts`', same shape. */
  previousCounts: OutcomeCounts;
  lines: StallLines;
}

function checkMetric(
  metric: StallMetric,
  count: number,
  previousCount: number,
  denominator: number,
  previousDenominator: number,
  lines: StallLines,
): StallVerdict | null {
  const threshold = lines[metric].stall;
  const current = rate(count, denominator);
  const previous = rate(previousCount, previousDenominator, RATE_FLOOR);

  const detail = (overrides: Partial<StallDetail> = {}): StallDetail => ({
    metric,
    count,
    denominator,
    rate: current,
    previousRate: previous,
    threshold,
    ...overrides,
  });

  // Below the volume floor a rate is noise — two bounces out of four sends isn't a 50% bounce
  // rate worth acting on statistically. A small absolute count still is, but only once the
  // denominator itself clears the count volume floor — below that, even the count is noise.
  if (current === null) {
    return denominator >= lines.countVolumeFloor && count >= lines[metric].count
      ? { reason: `${metric}_count`, detail: detail() }
      : null;
  }

  // Naive one-window linear projection: if the rate changes by the same amount again next
  // window, does it cross the line? It needs only the two windows already on hand.
  const crossing = projectsPast(current, previous, threshold);
  if (crossing === "level") return { reason: `${metric}_rate`, detail: detail() };
  if (crossing === "trend") return { reason: `${metric}_trend`, detail: detail() };

  return null;
}

/**
 * Complaints checked first: SES weighs a complaint far more heavily than a bounce, and the two
 * rarely trip in the same window, so which one is reported first is not a decision that costs
 * the other its stall — a caller wanting both reads `detail`.
 */
export function evaluateStall(input: StallCheckInput): StallVerdict | null {
  const denominator = resolved(input.counts);
  const previousDenominator = resolved(input.previousCounts);

  return (
    checkMetric(
      "complaint",
      input.counts.complained,
      input.previousCounts.complained,
      denominator,
      previousDenominator,
      input.lines,
    ) ?? checkMetric("bounce", input.counts.bounced, input.previousCounts.bounced, denominator, previousDenominator, input.lines)
  );
}

/** Said for a stall whose numbers weren't recorded. Matches a held message's `stall.message`. */
export const STALL_WITHOUT_DETAIL = "This domain is paused.";

/** One sentence for the dashboard: what fired and the numbers behind it. */
export function describeStall(reason: StallReason, detail: StallDetail | null): string {
  if (!detail) return STALL_WITHOUT_DETAIL;
  const noun = detail.metric === "bounce" ? "Bounce" : "Complaint";

  if (reason.endsWith("_count")) {
    const unit = detail.metric === "bounce" ? "bounce" : "complaint";
    return `${detail.count} ${unit}${detail.count === 1 ? "" : "s"} on ${detail.denominator} ${detail.denominator === 1 ? "send" : "sends"} — too few to trust a rate, not too few to stop.`;
  }

  const rateText = formatRate(detail.rate, 2);
  const thresholdText = formatRate(detail.threshold, 2);
  return reason.endsWith("_trend")
    ? `${noun} rate is ${rateText} and climbing — projected past our ${thresholdText} action point next window.`
    : `${noun} rate is ${rateText}, above our ${thresholdText} action point.`;
}

/** A domain's held queue, as the dashboard shows it. Null means it's sending normally. */
export interface DomainStallView {
  reason: StallReason;
  /** Null on a stall written without its numbers. It holds mail all the same. */
  detail: StallDetail | null;
  stalledAt: Date;
  /** One sentence: what fired and the numbers behind it. */
  summary: string;
}

/** Stalled: a timestamp and a reason. The API and dashboard ask this; the send queue's SQL checks `stalled_at` alone, and `domains_stall_pairing_check` keeps the two equal. */
export function isStalled<T extends { stalledAt: Date | null; stallReason: StallReason | null }>(
  domain: T,
): domain is T & { stalledAt: Date; stallReason: StallReason } {
  return domain.stalledAt !== null && domain.stallReason !== null;
}

/** Builds the view of a stall from the domain row's raw columns. */
export function domainStallView(domain: {
  stalledAt: Date | null;
  stallReason: StallReason | null;
  stallDetail: StallDetail | null;
}): DomainStallView | null {
  if (!isStalled(domain)) return null;
  return {
    reason: domain.stallReason,
    detail: domain.stallDetail,
    stalledAt: domain.stalledAt,
    summary: describeStall(domain.stallReason, domain.stallDetail),
  };
}
