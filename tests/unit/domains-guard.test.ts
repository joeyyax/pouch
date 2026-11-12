import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALL_LINES as LINES,
  STALL_WINDOW_DAYS,
  describeStall,
  evaluateStall,
  releaseCovers,
  stallLines,
  type StallVerdict,
} from "@/lib/domains/guard";
import { EMPTY_COUNTS, RATE_FLOOR, type OutcomeCounts } from "@/lib/metrics/rates";

const STALL_BOUNCE_RATE = LINES.bounce.stall;
const STALL_COMPLAINT_RATE = LINES.complaint.stall;
const STALL_BOUNCE_COUNT = LINES.bounce.count;
const STALL_COMPLAINT_COUNT = LINES.complaint.count;
const STALL_COUNT_VOLUME_FLOOR = LINES.countVolumeFloor;

function counts(overrides: Partial<OutcomeCounts>): OutcomeCounts {
  return { ...EMPTY_COUNTS, ...overrides };
}

/** Enough volume that a rate is computed at all. */
const RESOLVED = RATE_FLOOR * 2;

describe("a healthy domain", () => {
  it("never stalls, at any volume, with no bounces or complaints", () => {
    const healthy = counts({ total: RESOLVED, delivered: RESOLVED });
    expect(evaluateStall({ lines: LINES, counts: healthy, previousCounts: healthy })).toBeNull();
  });

  // Proves the test above actually exercises the threshold: nudge the bounce rate a hair over
  // STALL_BOUNCE_RATE on the same volume, and it must fire. If this one goes red, the "never
  // stalls" test above isn't testing anything.
  it("[control] the same volume just over the bounce action point does stall", () => {
    const bounced = Math.ceil(RESOLVED * (STALL_BOUNCE_RATE + 0.01));
    const over = counts({ total: RESOLVED, delivered: RESOLVED - bounced, bounced });
    expect(evaluateStall({ lines: LINES, counts: over, previousCounts: over })).not.toBeNull();
  });
});

describe("the bounce rate guard", () => {
  it("stalls once the rate is over the action point", () => {
    const bounced = Math.ceil(RESOLVED * (STALL_BOUNCE_RATE + 0.01));
    const current = counts({ total: RESOLVED, delivered: RESOLVED - bounced, bounced });
    const verdict = evaluateStall({ lines: LINES, counts: current, previousCounts: current });
    expect(verdict?.reason).toBe("bounce_rate");
  });

  it("stays quiet just under the action point", () => {
    const bounced = Math.floor(RESOLVED * (STALL_BOUNCE_RATE - 0.01));
    const current = counts({ total: RESOLVED, delivered: RESOLVED - bounced, bounced });
    expect(evaluateStall({ lines: LINES, counts: current, previousCounts: current })).toBeNull();
  });

  it("acts at half of SES's own review line, not at the review line itself", () => {
    expect(STALL_BOUNCE_RATE).toBeCloseTo(0.025);
  });
});

describe("the complaint rate guard", () => {
  it("stalls once the rate is over the action point", () => {
    const complained = Math.ceil(RESOLVED * (STALL_COMPLAINT_RATE + 0.0005));
    const current = counts({ total: RESOLVED, delivered: RESOLVED - complained, complained });
    const verdict = evaluateStall({ lines: LINES, counts: current, previousCounts: current });
    expect(verdict?.reason).toBe("complaint_rate");
  });

  it("is checked ahead of bounce, since a complaint is the worse signal", () => {
    const current = counts({
      total: RESOLVED,
      delivered: RESOLVED - 20,
      bounced: Math.ceil(RESOLVED * (STALL_BOUNCE_RATE + 0.01)),
      complained: Math.ceil(RESOLVED * (STALL_COMPLAINT_RATE + 0.0005)),
    });
    expect(evaluateStall({ lines: LINES, counts: current, previousCounts: current })?.reason).toBe("complaint_rate");
  });
});

describe("the trend guard", () => {
  it("stalls on a rate still under the line, projected to cross it next window", () => {
    // Comfortably under STALL_BOUNCE_RATE now, but the previous window was near zero — the
    // same jump again next window pushes it over.
    const resolved = RESOLVED * 2;
    const previous = counts({ total: resolved, delivered: resolved });
    const bounced = Math.floor(resolved * (STALL_BOUNCE_RATE - 0.002));
    const current = counts({ total: resolved, delivered: resolved - bounced, bounced });

    const verdict = evaluateStall({ lines: LINES, counts: current, previousCounts: previous });
    expect(verdict?.reason).toBe("bounce_trend");
  });

  it("stays quiet on one bounce off a clean window, which projects to double itself", () => {
    const previous = counts({ total: 78, delivered: 78 });
    const current = counts({ total: 78, delivered: 77, bounced: 1 });
    expect(evaluateStall({ lines: LINES, counts: current, previousCounts: previous })).toBeNull();
  });

  it("[control] the same trend at the bounce count line does stall", () => {
    const previous = counts({ total: 160, delivered: 160 });
    const current = counts({ total: 160, delivered: 160 - STALL_BOUNCE_COUNT, bounced: STALL_BOUNCE_COUNT });
    expect(evaluateStall({ lines: LINES, counts: current, previousCounts: previous })?.reason).toBe("bounce_trend");
  });

  it("stays quiet when the rate is falling", () => {
    const previous = counts({
      total: RESOLVED,
      delivered: RESOLVED - Math.floor(RESOLVED * (STALL_BOUNCE_RATE - 0.001)),
      bounced: Math.floor(RESOLVED * (STALL_BOUNCE_RATE - 0.001)),
    });
    const current = counts({ total: RESOLVED, delivered: RESOLVED - 1, bounced: 1 });
    expect(evaluateStall({ lines: LINES, counts: current, previousCounts: previous })).toBeNull();
  });

  it("has nothing to project from without a previous window", () => {
    const bounced = Math.floor(RESOLVED * (STALL_BOUNCE_RATE - 0.002));
    const current = counts({ total: RESOLVED, delivered: RESOLVED - bounced, bounced });
    const empty = counts({ total: 0 });
    expect(evaluateStall({ lines: LINES, counts: current, previousCounts: empty })).toBeNull();
  });
});

describe("the count guard, below the volume floor", () => {
  // Production's own numbers over 14 days: 4 delivered, 1 sent, 0 bounced, 0 complained. Nothing
  // trips at that volume either way — this is about the first client with real volume, where a
  // handful of sends and one bad address shouldn't stall a domain that's simply new.
  it("stays quiet on a domain-sized fluke: 3 bounces on 4 sends, below STALL_COUNT_VOLUME_FLOOR", () => {
    const low = counts({ total: 4, delivered: 1, bounced: STALL_BOUNCE_COUNT });
    expect(evaluateStall({ lines: LINES, counts: low, previousCounts: EMPTY_COUNTS })).toBeNull();
  });

  it("stays quiet on a single complaint out of a domain's first couple of sends", () => {
    const low = counts({ total: 2, delivered: 1, complained: STALL_COMPLAINT_COUNT });
    expect(evaluateStall({ lines: LINES, counts: low, previousCounts: EMPTY_COUNTS })).toBeNull();
  });

  // Proves the two tests above are testing the floor and not the count itself: the same counts,
  // once the denominator reaches STALL_COUNT_VOLUME_FLOOR, still stall.
  it("[control] the same bounce count, once there's enough volume to trust it, does stall", () => {
    const enough = counts({
      total: STALL_COUNT_VOLUME_FLOOR,
      delivered: STALL_COUNT_VOLUME_FLOOR - STALL_BOUNCE_COUNT,
      bounced: STALL_BOUNCE_COUNT,
    });
    const verdict = evaluateStall({ lines: LINES, counts: enough, previousCounts: EMPTY_COUNTS });
    expect(verdict?.reason).toBe("bounce_count");
  });

  it("[control] the same complaint count, once there's enough volume to trust it, does stall", () => {
    const enough = counts({
      total: STALL_COUNT_VOLUME_FLOOR,
      delivered: STALL_COUNT_VOLUME_FLOOR - STALL_COMPLAINT_COUNT,
      complained: STALL_COMPLAINT_COUNT,
    });
    const verdict = evaluateStall({ lines: LINES, counts: enough, previousCounts: EMPTY_COUNTS });
    expect(verdict?.reason).toBe("complaint_count");
  });

  it("stays quiet just under the count itself, even at floor volume", () => {
    const low = counts({
      total: STALL_COUNT_VOLUME_FLOOR,
      delivered: STALL_COUNT_VOLUME_FLOOR - (STALL_BOUNCE_COUNT - 1),
      bounced: STALL_BOUNCE_COUNT - 1,
    });
    expect(evaluateStall({ lines: LINES, counts: low, previousCounts: EMPTY_COUNTS })).toBeNull();
  });

  it("never fires the count guard once there's enough volume for a rate", () => {
    const healthy = counts({ total: RESOLVED, delivered: RESOLVED - 2, bounced: 2 });
    expect(evaluateStall({ lines: LINES, counts: healthy, previousCounts: healthy })).toBeNull();
  });
});

describe("tightened lines", () => {
  const tight = stallLines({ stall_bounce_percent: 1.5, stall_complaint_percent: 0.02, stall_bounce_count: 1, stall_count_volume_floor: 2 });

  it.each([
    ["a 2% bounce rate", counts({ total: 100, delivered: 98, bounced: 2 }), "bounce_rate"],
    ["a 0.03% complaint rate", counts({ total: 10_000, delivered: 9_997, complained: 3 }), "complaint_rate"],
    ["1 bounce on 2 sends", counts({ total: 2, delivered: 1, bounced: 1 }), "bounce_count"],
  ])("stall on %s, which the default lines let through", (_name, current, reason) => {
    expect(evaluateStall({ lines: LINES, counts: current, previousCounts: current })).toBeNull();
    expect(evaluateStall({ lines: tight, counts: current, previousCounts: current })?.reason).toBe(reason);
  });

  it("record the line that tripped", () => {
    const current = counts({ total: 100, delivered: 98, bounced: 2 });
    expect(evaluateStall({ lines: tight, counts: current, previousCounts: current })?.detail.threshold).toBe(0.015);
  });
});

describe("describeStall", () => {
  it("names the numbers for a rate reason", () => {
    const text = describeStall("bounce_rate", {
      metric: "bounce",
      count: 30,
      denominator: 1000,
      rate: 0.03,
      previousRate: 0.03,
      threshold: STALL_BOUNCE_RATE,
    });
    expect(text).toContain("3.00%");
    expect(text).toContain("2.50%");
  });

  it("names the counts for a count reason, not a percentage", () => {
    const text = describeStall("bounce_count", {
      metric: "bounce",
      count: 3,
      denominator: 4,
      rate: null,
      previousRate: null,
      threshold: STALL_BOUNCE_RATE,
    });
    expect(text).toContain("3 bounces on 4 sends");
    expect(text).not.toContain("%");
  });
});

describe("releaseCovers", () => {
  const now = new Date("2026-11-10T20:00:00Z");
  const detail = { metric: "bounce" as const, count: 1, denominator: 67, rate: 0.015, previousRate: 0, threshold: STALL_BOUNCE_RATE };
  const release = { releasedAt: new Date(now.getTime() - 60_000), detail };
  const verdict = (overrides: Partial<StallVerdict["detail"]>): StallVerdict => ({
    reason: "bounce_trend",
    detail: { ...detail, denominator: 78, ...overrides },
  });

  it("holds against the same bounce count on more sends", () => {
    expect(releaseCovers(release, verdict({}), now)).toBe(true);
  });

  it("gives way to a new bounce", () => {
    expect(releaseCovers(release, verdict({ count: 2 }), now)).toBe(false);
  });

  it("gives way to the other metric", () => {
    expect(releaseCovers(release, verdict({ metric: "complaint" }), now)).toBe(false);
  });

  it("expires after one window", () => {
    const old = { ...release, releasedAt: new Date(now.getTime() - STALL_WINDOW_DAYS * 24 * 60 * 60 * 1000) };
    expect(releaseCovers(old, verdict({}), now)).toBe(false);
  });

  it("covers nothing without a release", () => {
    expect(releaseCovers(null, verdict({}), now)).toBe(false);
  });
});
