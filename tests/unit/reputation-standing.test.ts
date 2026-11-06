import { describe, expect, it } from "vitest";
import {
  AT_RISK_SHARE,
  coveredMetrics,
  evaluateOrganizationStanding,
  evaluateStanding,
  FIRST_TIME_MIN_RECIPIENTS,
  NEW_DOMAIN_DAYS,
  SPIKE_AT_RISK_MULTIPLE,
  SPIKE_MIN_RECIPIENTS,
  SPIKE_MIN_VOLUME,
  SPIKE_WATCH_MULTIPLE,
  SUPPRESSED_AT_RISK_COUNT,
  SUPPRESSED_WATCH_COUNT,
  WATCH_SHARE,
  worseStanding,
  type BehaviorSignals,
  type StandingInput,
} from "@/lib/reputation/standing";
import { DEFAULT_STALL_LINES as LINES } from "@/lib/domains/guard";
import { EMPTY_COUNTS, type OutcomeCounts } from "@/lib/metrics/rates";

const STALL_BOUNCE_RATE = LINES.bounce.stall;
const STALL_COMPLAINT_RATE = LINES.complaint.stall;
const STALL_BOUNCE_COUNT = LINES.bounce.count;

const NOW = new Date("2026-09-16T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function counts(resolved: number, bounced = 0, complained = 0): OutcomeCounts {
  return { ...EMPTY_COUNTS, total: resolved, delivered: resolved - bounced - complained, bounced, complained };
}

/** Bounces for a given rate over 10,000 resolved messages, so the rate is exact. */
function bounceRate(rate: number): OutcomeCounts {
  return counts(10_000, Math.round(rate * 10_000));
}

function signals(overrides: Partial<BehaviorSignals> = {}): BehaviorSignals {
  return {
    recentTotal: 100,
    baselineTotal: 700,
    recentRecipients: 0,
    firstTimeRecipients: 0,
    suppressedRejections: 0,
    verifiedAt: new Date(NOW.getTime() - 90 * DAY_MS),
    now: NOW,
    ...overrides,
  };
}

function input(overrides: Partial<StandingInput> = {}): StandingInput {
  return {
    subject: "example.com",
    counts: counts(10_000),
    previousCounts: counts(10_000),
    signals: signals(),
    pause: null,
    lines: LINES,
    ...overrides,
  };
}

describe("evaluateStanding", () => {
  it("is healthy with clean numbers", () => {
    const result = evaluateStanding(input());
    expect(result.standing).toBe("healthy");
    expect(result.findings).toEqual([]);
  });

  it("watches a bounce rate just past half the stall line", () => {
    const line = STALL_BOUNCE_RATE * WATCH_SHARE;
    expect(evaluateStanding(input({ counts: bounceRate(line - 0.0001), previousCounts: bounceRate(line - 0.0001) })).standing).toBe(
      "healthy",
    );
    const result = evaluateStanding(input({ counts: bounceRate(line + 0.0001), previousCounts: bounceRate(line + 0.0001) }));
    expect(result.standing).toBe("watch");
    expect(result.findings[0]?.kind).toBe("bounce_rate");
  });

  it("puts a bounce rate within reach of the stall line at risk", () => {
    const rate = STALL_BOUNCE_RATE * AT_RISK_SHARE + 0.0001;
    const result = evaluateStanding(input({ counts: bounceRate(rate), previousCounts: bounceRate(rate) }));
    expect(result.standing).toBe("at_risk");
  });

  it("watches a rate that is still low but rising fast enough to cross the watch line", () => {
    const result = evaluateStanding(input({ counts: bounceRate(0.009), previousCounts: bounceRate(0.004) }));
    expect(result.standing).toBe("watch");
    expect(result.findings[0]?.title).toMatch(/rising/);
  });

  it("ignores a small rise that stays well under the watch line", () => {
    expect(evaluateStanding(input({ counts: bounceRate(0.004), previousCounts: bounceRate(0.002) })).standing).toBe("healthy");
  });

  it("ignores a rise when the previous window had too few messages to trust", () => {
    const result = evaluateStanding(input({ counts: bounceRate(0.009), previousCounts: counts(20) }));
    expect(result.standing).toBe("healthy");
  });

  it("watches complaints at half the complaint stall line", () => {
    const complaints = counts(100_000, 0, Math.ceil(STALL_COMPLAINT_RATE * WATCH_SHARE * 100_000) + 1);
    expect(evaluateStanding(input({ counts: complaints, previousCounts: complaints })).findings[0]?.kind).toBe("complaint_rate");
  });

  it("says the guard is about to pause when the stall evaluation already fires", () => {
    const result = evaluateStanding(input({ counts: bounceRate(0.03), previousCounts: bounceRate(0.03) }));
    expect(result.standing).toBe("at_risk");
    expect(result.findings.map((finding) => finding.kind)).toEqual(["stall_pending"]);
  });

  it("puts a count-based bounce signal below the rate floor at risk", () => {
    const result = evaluateStanding(input({ counts: counts(6, STALL_BOUNCE_COUNT), previousCounts: EMPTY_COUNTS }));
    expect(result.standing).toBe("at_risk");
    expect(result.findings[0]?.kind).toBe("bounce_count");
  });

  it("puts one complaint on a handful of sends at risk", () => {
    expect(evaluateStanding(input({ counts: counts(5, 0, 1), previousCounts: EMPTY_COUNTS })).standing).toBe("at_risk");
  });

  it("is paused when the domain is held, whatever the numbers say", () => {
    const result = evaluateStanding(input({ pause: { reason: "Bounce rate is 3.0%.", since: NOW } }));
    expect(result.standing).toBe("paused");
    expect(result.findings[0]?.kind).toBe("paused");
  });

  describe("behavior signals", () => {
    it("watch a volume spike against the domain's own baseline", () => {
      const daily = 100;
      const recent = Math.max(SPIKE_MIN_VOLUME, daily * SPIKE_WATCH_MULTIPLE);
      const result = evaluateStanding(
        input({ signals: signals({ baselineTotal: daily * 7, recentTotal: recent, recentRecipients: SPIKE_MIN_RECIPIENTS }) }),
      );
      expect(result.standing).toBe("watch");
      expect(result.findings[0]?.kind).toBe("volume_spike");
    });

    it("put an extreme spike at risk", () => {
      const result = evaluateStanding(
        input({ signals: signals({ baselineTotal: 70, recentTotal: 10 * SPIKE_AT_RISK_MULTIPLE, recentRecipients: SPIKE_MIN_RECIPIENTS }) }),
      );
      expect(result.standing).toBe("at_risk");
    });

    it("stay quiet on a spike to a few recipients", () => {
      const result = evaluateStanding(
        input({ signals: signals({ baselineTotal: 35, recentTotal: 205, recentRecipients: SPIKE_MIN_RECIPIENTS - 1 }) }),
      );
      expect(result.standing).toBe("healthy");
    });

    it("stay quiet on a spike below the minimum volume", () => {
      const result = evaluateStanding(input({ signals: signals({ baselineTotal: 7, recentTotal: SPIKE_MIN_VOLUME - 1 }) }));
      expect(result.standing).toBe("healthy");
    });

    it("have no baseline to spike against on a domain that never sent", () => {
      const result = evaluateStanding(input({ signals: signals({ baselineTotal: 0, recentTotal: 10_000 }) }));
      expect(result.findings.some((finding) => finding.kind === "volume_spike")).toBe(false);
    });

    it("watch a high share of first-time recipients", () => {
      const result = evaluateStanding(
        input({ signals: signals({ recentRecipients: FIRST_TIME_MIN_RECIPIENTS, firstTimeRecipients: FIRST_TIME_MIN_RECIPIENTS * 0.6 }) }),
      );
      expect(result.standing).toBe("watch");
      expect(result.findings[0]?.kind).toBe("first_time_recipients");
    });

    it("put a list that's almost entirely new at risk", () => {
      const result = evaluateStanding(input({ signals: signals({ recentRecipients: 500, firstTimeRecipients: 450 }) }));
      expect(result.standing).toBe("at_risk");
    });

    it("escalate repeated sends to suppressed addresses", () => {
      expect(evaluateStanding(input({ signals: signals({ suppressedRejections: SUPPRESSED_WATCH_COUNT - 1 }) })).standing).toBe(
        "healthy",
      );
      expect(evaluateStanding(input({ signals: signals({ suppressedRejections: SUPPRESSED_WATCH_COUNT }) })).standing).toBe("watch");
      expect(evaluateStanding(input({ signals: signals({ suppressedRejections: SUPPRESSED_AT_RISK_COUNT }) })).standing).toBe(
        "at_risk",
      );
    });

    it("watch a hard bounce on a newly verified domain's first sends", () => {
      const fresh = signals({ verifiedAt: new Date(NOW.getTime() - 2 * DAY_MS), baselineTotal: 0 });
      const result = evaluateStanding(input({ counts: counts(12, 1), previousCounts: EMPTY_COUNTS, signals: fresh }));
      expect(result.standing).toBe("watch");
      expect(result.findings[0]?.kind).toBe("new_domain_bounces");
    });

    it("don't treat one bounce on an established domain as a signal", () => {
      const old = signals({ verifiedAt: new Date(NOW.getTime() - (NEW_DOMAIN_DAYS + 1) * DAY_MS) });
      expect(evaluateStanding(input({ counts: counts(12, 1), previousCounts: EMPTY_COUNTS, signals: old })).standing).toBe(
        "healthy",
      );
    });

    it("never pause on their own", () => {
      const everything = signals({
        baselineTotal: 7,
        recentTotal: 100_000,
        recentRecipients: 100_000,
        firstTimeRecipients: 100_000,
        suppressedRejections: 10_000,
      });
      expect(evaluateStanding(input({ signals: everything })).standing).toBe("at_risk");
    });
  });
});

describe("evaluateOrganizationStanding", () => {
  const clean = { counts: counts(10_000), previousCounts: counts(10_000) };

  it("takes the worst domain, but a paused domain only makes the organization at risk", () => {
    const result = evaluateOrganizationStanding({
      lines: LINES,
      subject: "Acme",
      sums: clean,
      sendingDomains: 2,
      suspension: null,
      domains: [
        { id: "a", name: "a.com", standing: "watch" },
        { id: "b", name: "b.com", standing: "paused" },
      ],
    });
    expect(result.standing).toBe("at_risk");
    expect(result.ownStanding).toBe("healthy");
  });

  it("is paused when the organization is suspended", () => {
    const result = evaluateOrganizationStanding({
      lines: LINES,
      subject: "Acme",
      sums: clean,
      sendingDomains: 1,
      suspension: { reason: "Suspended by an operator.", since: NOW },
      domains: [],
    });
    expect(result.standing).toBe("paused");
  });

  it("reads the summed rates only with two or more sending domains, like the org guard", () => {
    const high = { counts: bounceRate(0.022), previousCounts: bounceRate(0.022) };
    const one = evaluateOrganizationStanding({ lines: LINES, subject: "Acme", sums: high, sendingDomains: 1, suspension: null, domains: [] });
    const two = evaluateOrganizationStanding({ lines: LINES, subject: "Acme", sums: high, sendingDomains: 2, suspension: null, domains: [] });
    expect(one.standing).toBe("healthy");
    expect(two.standing).toBe("at_risk");
  });
});

describe("worseStanding", () => {
  it("orders healthy, watch, at risk, paused", () => {
    expect(worseStanding("watch", "healthy")).toBe(true);
    expect(worseStanding("paused", "at_risk")).toBe(true);
    expect(worseStanding("at_risk", "at_risk")).toBe(false);
    expect(worseStanding("watch", "at_risk")).toBe(false);
  });
});

describe("provider findings", () => {
  const clean = { counts: counts(10_000), previousCounts: counts(10_000) };
  const base = { subject: "Acme", sums: clean, sendingDomains: 1, suspension: null, domains: [] };

  it("put the organization at risk on a high-impact finding and on watch otherwise", () => {
    const high = evaluateOrganizationStanding({
      lines: LINES,
      ...base,
      providerFindings: [{ type: "BOUNCE", impact: "HIGH", description: "The bounce rate exceeded 15.0%." }],
    });
    expect(high.ownStanding).toBe("at_risk");
    expect(high.findings[0]).toMatchObject({ kind: "provider_finding", body: "The bounce rate exceeded 15.0%." });

    const low = evaluateOrganizationStanding({ lines: LINES, ...base, providerFindings: [{ type: "COMPLAINT", impact: "LOW", description: null }] });
    expect(low.ownStanding).toBe("watch");
  });

  it("never pause on their own", () => {
    const result = evaluateOrganizationStanding({
      lines: LINES,
      ...base,
      providerFindings: [
        { type: "BOUNCE", impact: "HIGH", description: null },
        { type: "COMPLAINT", impact: "HIGH", description: null },
      ],
    });
    expect(result.standing).toBe("at_risk");
  });
});

describe("AWS account rates", () => {
  const clean = { counts: counts(10_000), previousCounts: counts(10_000) };
  const base = { subject: "Acme", sums: clean, sendingDomains: 1, suspension: null, domains: [] };
  const provider = { providerName: "Primary", bounceRate: null, complaintRate: null, covered: [], domainId: "dom_1" };

  it("stay healthy under the watch line", () => {
    const result = evaluateOrganizationStanding({
      lines: LINES,
      ...base,
      providerRates: [{ ...provider, bounceRate: STALL_BOUNCE_RATE * WATCH_SHARE * 0.99, complaintRate: 0 }],
    });
    expect(result.ownStanding).toBe("healthy");
    expect(result.findings).toEqual([]);
  });

  it("raise watch past the watch line and at risk past the at-risk line, never paused", () => {
    const watch = evaluateOrganizationStanding({ lines: LINES, ...base, providerRates: [{ ...provider, bounceRate: STALL_BOUNCE_RATE * WATCH_SHARE }] });
    expect(watch.ownStanding).toBe("watch");
    expect(watch.findings[0]).toMatchObject({ kind: "provider_rate", domainId: "dom_1" });

    const atRisk = evaluateOrganizationStanding({ lines: LINES, ...base, providerRates: [{ ...provider, complaintRate: STALL_COMPLAINT_RATE * AT_RISK_SHARE }] });
    expect(atRisk.ownStanding).toBe("at_risk");

    const pastPause = evaluateOrganizationStanding({ lines: LINES, ...base, providerRates: [{ ...provider, bounceRate: 0.5, complaintRate: 0.5 }] });
    expect(pastPause.standing).toBe("at_risk");
  });

  it("stay out of a metric a domain on the provider already reports", () => {
    const result = evaluateOrganizationStanding({
      lines: LINES,
      ...base,
      providerRates: [{ ...provider, bounceRate: 0.04, complaintRate: STALL_COMPLAINT_RATE * WATCH_SHARE, covered: ["bounce"] }],
    });
    expect(result.findings.map((finding) => finding.title)).toEqual(["AWS reports a 0.025% complaint rate on Primary"]);
  });

  it("stay out of a metric the organization's own sums already report", () => {
    const result = evaluateOrganizationStanding({
      lines: LINES,
      ...base,
      sums: { counts: bounceRate(0.022), previousCounts: bounceRate(0.022) },
      sendingDomains: 2,
      providerRates: [{ ...provider, bounceRate: 0.04 }],
    });
    expect(result.findings.some((finding) => finding.kind === "provider_rate")).toBe(false);
  });
});

describe("coveredMetrics", () => {
  it("reads a pause or pending stall as covering both metrics", () => {
    expect(coveredMetrics([{ kind: "stall_pending" }]).sort()).toEqual(["bounce", "complaint"]);
    expect(coveredMetrics([{ kind: "complaint_count" }])).toEqual(["complaint"]);
    expect(coveredMetrics([{ kind: "volume_spike" }])).toEqual([]);
  });
});
