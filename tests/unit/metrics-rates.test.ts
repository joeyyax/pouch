import { describe, expect, it } from "vitest";
import {
  countDelta,
  deltaTone,
  formatRate,
  formatRateDelta,
  rate,
  rateDelta,
  rateFor,
  resolved,
  RATE_FLOOR,
  EMPTY_COUNTS,
  type OutcomeCounts,
} from "@/lib/metrics/rates";

function counts(overrides: Partial<OutcomeCounts>): OutcomeCounts {
  return { ...EMPTY_COUNTS, ...overrides };
}

describe("the volume floor", () => {
  it("refuses a percentage off too few messages", () => {
    // One bounce in three sends is one bounce, not 33%.
    expect(rate(1, 3)).toBeNull();
  });

  it("computes one once there's enough to mean something", () => {
    expect(rate(5, RATE_FLOOR)).toBeCloseTo(0.1);
  });

  it("refuses a percentage of nothing rather than dividing by zero", () => {
    expect(rate(0, 0)).toBeNull();
  });
});

describe("what counts as the denominator", () => {
  it("is only messages that reached an outcome", () => {
    expect(resolved(counts({ delivered: 90, bounced: 5, complained: 1, failed: 4 }))).toBe(100);
  });

  it("leaves in-flight messages out, so a recent window isn't punished for them", () => {
    const window = counts({ total: 200, delivered: 100, inFlight: 99, queued: 1 });

    expect(resolved(window)).toBe(100);
    expect(rateFor(window, "delivered")).toBe(1);
  });
});

describe("comparing to the previous window", () => {
  it("gives the change in percentage points", () => {
    expect(rateDelta(0.06, 0.04)).toBeCloseTo(0.02);
  });

  it("gives nothing when either side was refused", () => {
    expect(rateDelta(0.06, null)).toBeNull();
    expect(rateDelta(null, 0.04)).toBeNull();
  });

  it("has no baseline to compare against when the previous window was empty", () => {
    expect(countDelta(10, 0)).toBeNull();
  });
});

describe("which direction is good", () => {
  it("treats more delivered as good and more bounced as bad", () => {
    expect(deltaTone("delivered", 0.02)).toBe("success");
    expect(deltaTone("bounced", 0.02)).toBe("danger");
  });

  it("treats fewer complaints as good", () => {
    expect(deltaTone("complained", -0.02)).toBe("success");
  });

  it("stays neutral when nothing moved", () => {
    expect(deltaTone("bounced", 0)).toBe("muted");
    expect(deltaTone("bounced", null)).toBe("muted");
  });
});

describe("formatting", () => {
  it("shows a dash rather than a fake zero when the rate is unknown", () => {
    expect(formatRate(null)).toBe("—");
  });

  it("keeps a decimal, because the thresholds sit at 5% and 0.1%", () => {
    expect(formatRate(0.05)).toBe("5.0%");
    expect(formatRate(0.001, 2)).toBe("0.10%");
  });

  it("signs a delta in points and says nothing about a rounding-error move", () => {
    expect(formatRateDelta(0.004)).toBe("+0.4pp");
    expect(formatRateDelta(-0.004)).toBe("−0.4pp");
    expect(formatRateDelta(0.000001)).toBeNull();
  });
});
