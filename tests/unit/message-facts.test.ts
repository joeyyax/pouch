import { describe, expect, it } from "vitest";
import { chooseFacts, MAX_FACTS, NOTABLE_SCORE, percentileOf, span, type FactInput } from "@/lib/dashboard/message-facts";

const NOW = new Date("2026-10-01T12:00:00Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

const STATS: NonNullable<FactInput["stats"]> = {
  computedAt: new Date("2026-10-01T11:30:00Z"),
  deliveryWindowStart: new Date(NOW.getTime() - 7 * DAY),
  deliveredCount: 500,
  deliveryMinMs: 500,
  deliveryP10Ms: 1000,
  deliveryP25Ms: 2000,
  deliveryP50Ms: 3000,
  deliveryP75Ms: 4000,
  deliveryP90Ms: 6000,
  deliveryP99Ms: 20_000,
  deliveryMaxMs: 60_000,
  volumeWindowStart: new Date(NOW.getTime() - 28 * DAY),
  hourlyVolume: Array.from({ length: 24 }, () => 20),
};

/** Sent 10 seconds after accept, delivered 3 seconds later: nothing stands out. */
function input(overrides: Partial<FactInput> = {}): FactInput {
  const createdAt = new Date("2026-10-01T10:00:00Z");
  return {
    now: NOW,
    domainName: "example.com",
    testMode: false,
    createdAt,
    sentAt: new Date(createdAt.getTime() + 10 * SECOND),
    deliveredAt: new Date(createdAt.getTime() + 13 * SECOND),
    attempts: 1,
    events: [],
    messageCount: 5,
    history: { firstSeenAt: new Date(createdAt.getTime() - 30 * DAY), bounceCount: 0, complaintCount: 0 },
    fanout: { recipients: 1, day: "2026-10-01" },
    stats: STATS,
    sensitive: null,
    ...overrides,
  };
}

function texts(overrides: Partial<FactInput>): string[] {
  return chooseFacts(input(overrides)).map((fact) => fact.text);
}

/** sentAt and deliveredAt `ms` apart, at an hour with ordinary volume. */
function delivered(ms: number): Partial<FactInput> {
  const sentAt = new Date("2026-10-01T10:00:10Z");
  return { sentAt, deliveredAt: new Date(sentAt.getTime() + ms) };
}

describe("chooseFacts", () => {
  it("returns nothing for an ordinary message", () => {
    expect(chooseFacts(input())).toEqual([]);
  });

  it("returns nothing when only fillers qualify", () => {
    expect(
      texts({ sentAt: new Date("2026-10-01T10:00:00.400Z"), deliveredAt: null, fanout: { recipients: 4, day: "2026-10-01" } }),
    ).toEqual([]);
  });

  it("pairs a lone notable fact with the best ordinary one", () => {
    const facts = chooseFacts(input({ attempts: 2 }));
    expect(facts.map((fact) => fact.text)).toEqual(["Sent on the second attempt.", "Delivered 3 seconds after it sent."]);
    expect(facts[0]?.score).toBeGreaterThanOrEqual(NOTABLE_SCORE);
    expect(facts[1]?.score).toBeLessThan(NOTABLE_SCORE);
  });

  it("keeps the four highest scores, highest first", () => {
    const facts = chooseFacts(
      input({
        attempts: 4,
        events: [{ kind: "backoff", status: null, detail: { count: 3 } }],
        history: { firstSeenAt: new Date("2025-01-01T00:00:00Z"), bounceCount: 2, complaintCount: 1 },
        messageCount: 1000,
        fanout: { recipients: 312, day: "2026-10-01" },
        createdAt: new Date("2026-10-01T09:50:00Z"),
      }),
    );
    expect(facts).toHaveLength(MAX_FACTS);
    expect(facts.map((fact) => fact.score)).toEqual([...facts.map((fact) => fact.score)].sort((a, b) => b - a));
    expect(facts[0]?.text).toBe("This address marked one other message as spam.");
    expect(facts[1]?.text).toBe("Mail to this address bounced 2 other times.");
  });

  it("drops delivery and queue facts in test mode", () => {
    expect(texts({ testMode: true, ...delivered(60_000) })).toEqual([]);
  });

  describe("queue wait", () => {
    it("is neutral from a minute and a warning from five", () => {
      const created = new Date("2026-10-01T10:00:00Z");
      const at = (ms: number) => chooseFacts(input({ createdAt: created, sentAt: new Date(created.getTime() + ms), deliveredAt: null }));
      expect(at(59 * SECOND)).toEqual([]);
      expect(at(2 * MINUTE)[0]).toMatchObject({ tone: "neutral", text: "Waited 2 minutes in the queue before it sent." });
      expect(at(12 * MINUTE)[0]).toMatchObject({ tone: "warn", text: "Waited 12 minutes in the queue before it sent." });
    });
  });

  describe("attempts and backoff", () => {
    it("names three or more attempts as a warning", () => {
      expect(chooseFacts(input({ attempts: 3 }))[0]).toMatchObject({ tone: "warn", text: "Took 3 attempts to send." });
    });

    it("sums coalesced backoff counts", () => {
      const events: FactInput["events"] = [
        { kind: "backoff", status: null, detail: { count: 2 } },
        { kind: "backoff", status: null, detail: {} },
      ];
      expect(texts({ events })).toContain("Held 3 times by the provider’s rate limit.");
      expect(texts({ events: [{ kind: "backoff", status: null, detail: { count: 1 } }] })).toContain(
        "Held once by the provider’s rate limit.",
      );
    });
  });

  describe("delivery against the domain", () => {
    it("is quiet between p10 and p90", () => {
      expect(texts(delivered(3000))).toEqual([]);
      expect(texts(delivered(5500))).toEqual([]);
    });

    it("says faster than most below p10", () => {
      expect(texts(delivered(800))).toEqual(["Delivered in 0.8 seconds, faster than 94% of example.com’s mail this week."]);
    });

    it("says slower than most above p90", () => {
      const facts = chooseFacts(input(delivered(13_000)));
      expect(facts).toEqual([
        { tone: "warn", score: 69, text: "Delivered in 13 seconds, slower than 94% of example.com’s mail this week." },
      ]);
    });

    it("names the week's slowest and fastest", () => {
      expect(texts(delivered(60_000))).toEqual(["The slowest delivery example.com had this week."]);
      expect(texts(delivered(400))).toEqual(["The fastest delivery example.com had this week."]);
    });

    it("says every delivery for a message sent after the window closed", () => {
      const sentAt = new Date("2026-10-01T11:45:00Z");
      expect(texts({ createdAt: new Date(sentAt.getTime() - 5 * SECOND), sentAt, deliveredAt: new Date(sentAt.getTime() + 90_000) })).toEqual([
        "Slower than every delivery example.com had this week.",
      ]);
    });

    it("compares nothing for a message sent before the window", () => {
      const sentAt = new Date(NOW.getTime() - 10 * DAY);
      expect(texts({ createdAt: sentAt, sentAt, deliveredAt: new Date(sentAt.getTime() + 60_000) })).toEqual([]);
    });

    it("compares nothing under the delivered floor or with a flat window", () => {
      expect(texts({ ...delivered(800), stats: { ...STATS, deliveredCount: 49 } })).toEqual(["Delivered 0.8 seconds after it sent."]);
      expect(texts({ ...delivered(800), stats: { ...STATS, deliveryMinMs: 3000, deliveryMaxMs: 3000 } })).toEqual([
        "Delivered 0.8 seconds after it sent.",
      ]);
    });

    it("falls back to the absolute time without a stats row", () => {
      expect(texts({ ...delivered(800), stats: null })).toEqual(["Delivered 0.8 seconds after it sent."]);
      expect(texts({ ...delivered(15 * MINUTE), stats: null })).toEqual(["Took 15 minutes to deliver."]);
      expect(texts({ ...delivered(5000), stats: null })).toEqual([]);
    });
  });

  describe("recipient history", () => {
    it("names a first message within a minute of first seen, only beside a notable fact", () => {
      const createdAt = new Date("2026-10-01T10:00:00Z");
      const first = { createdAt, history: { firstSeenAt: new Date(createdAt.getTime() + 200), bounceCount: 0, complaintCount: 0 } };
      expect(texts(first)).toEqual([]);
      expect(texts({ ...first, attempts: 3 })).toContain("The first message you’ve sent to this address.");
      expect(
        texts({ createdAt, history: { firstSeenAt: new Date(createdAt.getTime() - 2 * MINUTE), bounceCount: 0, complaintCount: 0 } }),
      ).toEqual([]);
    });

    it("leaves this message's own bounce out of the count", () => {
      const history = { firstSeenAt: new Date("2025-01-01T00:00:00Z"), bounceCount: 1, complaintCount: 0 };
      const ownBounce: FactInput["events"] = [{ kind: "transition", status: "bounced", detail: {} }];
      expect(texts({ history, events: ownBounce, deliveredAt: null })).toEqual([]);
      expect(texts({ history: { ...history, bounceCount: 2 }, events: ownBounce, deliveredAt: null })).toEqual([
        "Mail to this address bounced one other time.",
      ]);
    });

    it("has nothing to say without a history row", () => {
      expect(texts({ history: null })).toEqual([]);
    });
  });

  describe("message count", () => {
    it("starts at 100 and scores round numbers higher", () => {
      expect(texts({ messageCount: 99 })).toEqual([]);
      const plain = chooseFacts(input({ messageCount: 1204 }))[0];
      const round = chooseFacts(input({ messageCount: 1000 }))[0];
      expect(plain?.text).toBe("One of 1,204 messages you’ve sent to this address.");
      expect(round?.score).toBeGreaterThan(plain?.score ?? 0);
    });
  });

  describe("fan-out", () => {
    it("is notable from 10 recipients and says today or that day", () => {
      expect(texts({ fanout: { recipients: 9, day: "2026-10-01" } })).toEqual([]);
      expect(texts({ fanout: { recipients: 312, day: "2026-10-01" } })).toContain("The same body went to 312 people from this key today.");
      expect(texts({ fanout: { recipients: 12, day: "2026-09-20" } })).toContain("The same body went to 12 people from this key that day.");
    });
  });

  describe("hour of day", () => {
    const sentAt = new Date("2026-10-01T10:00:10Z");
    const profile = (hour10: number, others = 20) => Array.from({ length: 24 }, (_, hour) => (hour === 10 ? hour10 : others));

    it("names the busiest and quietest hour", () => {
      expect(texts({ sentAt, stats: { ...STATS, hourlyVolume: profile(60) } })).toContain("Sent in example.com’s busiest hour of the day.");
      expect(texts({ sentAt, stats: { ...STATS, hourlyVolume: profile(2) } })).toContain("Sent in example.com’s quietest hour of the day.");
    });

    it("needs a strict top slot, real volume and a 28-day window", () => {
      const tied = profile(60);
      tied[11] = 60;
      expect(texts({ sentAt, stats: { ...STATS, hourlyVolume: tied } })).toEqual([]);
      expect(texts({ sentAt, stats: { ...STATS, hourlyVolume: profile(30, 5) } })).toEqual([]);
      expect(texts({ sentAt, stats: { ...STATS, hourlyVolume: profile(25) } })).toEqual([]);
    });
  });

  describe("sensitive mail to one address", () => {
    const sensitive = (week: number, day: number, reason = "a sign-in link") => ({ sensitive: { reason, week, day } });

    it("shows from the third this week, named by the reason", () => {
      expect(texts(sensitive(2, 2))).toEqual([]);
      expect(chooseFacts(input(sensitive(3, 1)))[0]).toMatchObject({ tone: "neutral", text: "The third sign-in link to this address this week." });
      expect(texts(sensitive(7, 3, "an invitation link"))).toContain("The seventh invitation link to this address this week.");
      expect(texts(sensitive(12, 4))).toContain("The 12th sign-in link to this address this week.");
    });

    it("calls an empty reason a sensitive message", () => {
      expect(texts(sensitive(5, 1, ""))).toContain("The fifth sensitive message to this address this week.");
    });

    it("warns from 10 in 24 hours, saying someone may be targeting the account", () => {
      expect(chooseFacts(input(sensitive(10, 9)))[0]?.tone).toBe("neutral");
      const facts = chooseFacts(input({ ...sensitive(14, 10), history: { firstSeenAt: new Date("2025-01-01T00:00:00Z"), bounceCount: 3, complaintCount: 1 } }));
      expect(facts[0]).toMatchObject({
        tone: "warn",
        text: "The tenth sign-in link to this address in 24 hours. Someone may be targeting this account.",
      });
      expect(facts[0]?.score).toBeGreaterThan(90);
      expect(texts(sensitive(23, 22, ""))).toContain("The 22nd sensitive message to this address in 24 hours. Someone may be targeting this account.");
    });

    it("says nothing in test mode or without counts", () => {
      expect(texts({ ...sensitive(12, 12), testMode: true })).toEqual([]);
      expect(texts({ sensitive: null })).toEqual([]);
    });
  });
});

describe("percentileOf", () => {
  it("interpolates between stored quantiles", () => {
    expect(percentileOf(2500, STATS)).toBe(37.5);
    expect(percentileOf(500, STATS)).toBe(0);
    expect(percentileOf(60_000, STATS)).toBe(100);
  });

  it("is null with a quantile missing", () => {
    expect(percentileOf(2500, { ...STATS, deliveryP50Ms: null })).toBeNull();
  });
});

describe("span", () => {
  it("keeps a decimal under ten seconds", () => {
    expect(span(1800)).toBe("1.8 seconds");
    expect(span(1000)).toBe("1 second");
    expect(span(3020)).toBe("3 seconds");
    expect(span(42_000)).toBe("42 seconds");
    expect(span(2 * 60 * MINUTE)).toBe("2 hours");
  });
});
