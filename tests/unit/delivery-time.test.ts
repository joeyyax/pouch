import { describe, expect, it } from "vitest";
import {
  describeDeliveryShift,
  MIN_BASELINE_ROWS,
  MIN_DELIVERED,
  readDeliveryShift,
  SLOW_FLOOR_MS,
  SLOW_MULTIPLE,
  type DeliveryTimeRow,
} from "@/lib/metrics/delivery-time";
import { evaluateStanding } from "@/lib/reputation/standing";
import { EMPTY_COUNTS } from "@/lib/metrics/rates";
import { DEFAULT_STALL_LINES } from "@/lib/domains/guard";

const NOW = new Date("2026-10-15T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const day = (back: number) => new Date(NOW.getTime() - back * DAY_MS).toISOString().slice(0, 10);

/** A row per day back, 7 to 14 days ago, all at `baselineMs`; today's at `todayMs`. */
function history(todayMs: number, { baselineMs = 40_000, baselineRows = 8, delivered = 500, todayDelivered = 500 } = {}): DeliveryTimeRow[] {
  const baseline = Array.from({ length: baselineRows }, (_, index) => ({ day: day(7 + index), deliveredCount: delivered, p90Ms: baselineMs }));
  // Rows between are windows that overlap today's; they carry the rise and must not set the baseline.
  const overlapping = Array.from({ length: 6 }, (_, index) => ({ day: day(1 + index), deliveredCount: delivered, p90Ms: todayMs }));
  return [{ day: day(0), deliveredCount: todayDelivered, p90Ms: todayMs }, ...overlapping, ...baseline];
}

describe("readDeliveryShift", () => {
  it("fires on a real rise", () => {
    const shift = readDeliveryShift(history(240_000), NOW);
    expect(shift).toEqual({ p90Ms: 240_000, baselineMs: 40_000, delivered: 500 });
    expect(describeDeliveryShift(shift!)).toBe("4 minutes, against 40 seconds the 7 days before");
  });

  it("fires at exactly the multiple and the floor", () => {
    expect(readDeliveryShift(history(SLOW_FLOOR_MS, { baselineMs: SLOW_FLOOR_MS / SLOW_MULTIPLE }), NOW)).not.toBeNull();
  });

  it("is silent on a normal day", () => {
    expect(readDeliveryShift(history(45_000), NOW)).toBeNull();
  });

  it("is silent on a multiple that clears the ratio but not the floor", () => {
    // 3x of 2 seconds is 6 seconds: well under the floor.
    expect(readDeliveryShift(history(6_000, { baselineMs: 2_000 }), NOW)).toBeNull();
  });

  it("is silent on a high p90 that is only the domain's normal", () => {
    expect(readDeliveryShift(history(120_000, { baselineMs: 100_000 }), NOW)).toBeNull();
  });

  it("is silent without enough baseline history", () => {
    expect(readDeliveryShift(history(240_000, { baselineRows: MIN_BASELINE_ROWS - 1 }), NOW)).toBeNull();
    expect(readDeliveryShift(history(240_000, { baselineRows: MIN_BASELINE_ROWS }), NOW)).not.toBeNull();
  });

  it("is silent when the baseline rows are too thin to trust", () => {
    expect(readDeliveryShift(history(240_000, { delivered: MIN_DELIVERED - 1 }), NOW)).toBeNull();
  });

  it("is silent when today's p90 rests on too few messages", () => {
    expect(readDeliveryShift(history(240_000, { todayDelivered: MIN_DELIVERED - 1 }), NOW)).toBeNull();
  });

  it("is silent when today's row hasn't been written", () => {
    expect(readDeliveryShift(history(240_000).slice(1), NOW)).toBeNull();
  });

  it("reads the baseline from windows that end before today's begins", () => {
    const rows = history(240_000).map((row) => (row.day === day(7) ? { ...row, p90Ms: 230_000 } : row));
    // One baseline row at 230s among seven at 40s: the median stays 40s.
    expect(readDeliveryShift(rows, NOW)?.baselineMs).toBe(40_000);
  });
});

describe("delivery time in standing", () => {
  const signals = (deliveryTime: ReturnType<typeof readDeliveryShift>) => ({
    recentTotal: 100,
    baselineTotal: 700,
    recentRecipients: 0,
    firstTimeRecipients: 0,
    suppressedRejections: 0,
    deliveryTime,
    verifiedAt: new Date("2026-01-01T00:00:00Z"),
    now: NOW,
  });
  const evaluate = (deliveryTime: ReturnType<typeof readDeliveryShift>) =>
    evaluateStanding({ subject: "example.com", counts: EMPTY_COUNTS, previousCounts: EMPTY_COUNTS, signals: signals(deliveryTime), pause: null, lines: DEFAULT_STALL_LINES });

  it("puts a slow domain at watch and says what's slow, by how much and that throttling comes first", () => {
    const result = evaluate(readDeliveryShift(history(240_000), NOW));
    expect(result.standing).toBe("watch");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: "delivery_time",
      title: "Delivery on example.com is 6× slower than usual",
      body: "The slowest tenth of messages took 4 minutes, against 40 seconds the 7 days before. Slow delivery often comes before bounces: a mailbox provider is throttling the domain.",
    });
  });

  it("stays healthy on a normal day", () => {
    expect(evaluate(readDeliveryShift(history(45_000), NOW)).standing).toBe("healthy");
  });
});
