import { describe, expect, it } from "vitest";
import { reputationAlertSubject, reputationAlertText, type ReputationAlertInput } from "@/lib/mail/alerts/reputation-changed";
import { evaluateStanding } from "@/lib/reputation/standing";
import { alertFor } from "@/lib/reputation/transitions";
import { EMPTY_COUNTS } from "@/lib/metrics/rates";
import { DEFAULT_STALL_LINES } from "@/lib/domains/guard";

const NOW = new Date("2026-09-16T12:00:00Z");

function alert(overrides: Partial<ReputationAlertInput> = {}): ReputationAlertInput {
  const counts = { ...EMPTY_COUNTS, delivered: 978, bounced: 22 };
  const { standing, findings } = evaluateStanding({ subject: "example.com", counts, previousCounts: counts, signals: null, pause: null, lines: DEFAULT_STALL_LINES });
  return {
    kind: "entered",
    subjectType: "domain",
    subjectName: "example.com",
    standing,
    findings,
    url: "https://pouch.test/domains/dom_1/reputation",
    changedAt: NOW,
    ...overrides,
  };
}

describe("reputation alert copy", () => {
  it("says what's happening, the numbers and what to do", () => {
    const text = reputationAlertText(alert());
    expect(reputationAlertSubject(alert())).toBe("At risk of pausing: example.com");
    expect(text).toContain("2.20% of 1,000 resolved messages in 7 days");
    expect(text).toContain("Sending pauses at 2.50%");
    expect(text).toContain("What to do: Remove addresses that bounce");
    expect(text).toContain("https://pouch.test/domains/dom_1/reputation");
  });

  it("asks for a look, not a pause, when only sending behavior changed", () => {
    const spike = { kind: "volume_spike" as const, standing: "at_risk" as const, title: "Volume on example.com is up 37×", body: "", action: "" };
    const input = alert({ standing: "at_risk", findings: [spike] });
    expect(reputationAlertSubject(input)).toBe("Worth a look: example.com");
    expect(reputationAlertText(input)).toContain("Nothing is paused, and this won't pause it.");
    expect(reputationAlertText(input)).not.toContain("pauses its sending");
  });

  it("names a blocklist without threatening a pause", () => {
    const listing = { kind: "blocklist_listing" as const, standing: "at_risk" as const, title: "example.com is on Spamhaus DBL", body: "", action: "" };
    const input = alert({ standing: "at_risk", findings: [listing] });
    expect(reputationAlertSubject(input)).toBe("On a blocklist: example.com");
    expect(reputationAlertText(input)).toContain("isn't pausing it");
  });

  it("names a pause and a release", () => {
    expect(reputationAlertSubject(alert({ standing: "paused" }))).toBe("Sending paused: example.com");
    expect(reputationAlertSubject(alert({ kind: "released", standing: "healthy" }))).toBe("Sending resumed: example.com");
  });
});

describe("alertFor", () => {
  const recently = { alertedStanding: "at_risk" as const, alertedAt: new Date(NOW.getTime() - 60_000) };
  const HOUR = 3_600_000;

  it("alerts on entering at risk or paused, never watch", () => {
    expect(alertFor(null, "healthy", "at_risk", NOW, 24)).toBe("entered");
    expect(alertFor(null, "watch", "paused", NOW, 24)).toBe("entered");
    expect(alertFor(null, "healthy", "watch", NOW, 24)).toBeNull();
  });

  it("throttles the same standing inside the window and not after", () => {
    expect(alertFor(recently, "watch", "at_risk", NOW, 24)).toBeNull();
    expect(alertFor(recently, "watch", "at_risk", new Date(NOW.getTime() + 24 * HOUR), 24)).toBe("entered");
  });

  it("measures the window in the hours it's given", () => {
    expect(alertFor(recently, "watch", "at_risk", new Date(NOW.getTime() + HOUR), 2)).toBeNull();
    expect(alertFor(recently, "watch", "at_risk", new Date(NOW.getTime() + 2 * HOUR), 2)).toBe("entered");
  });

  it("never throttles a worse standing", () => {
    expect(alertFor(recently, "at_risk", "paused", NOW, 24)).toBe("entered");
  });

  it("calls leaving paused a release", () => {
    expect(alertFor({ alertedStanding: "paused", alertedAt: NOW }, "paused", "watch", NOW, 24)).toBe("released");
  });
});
