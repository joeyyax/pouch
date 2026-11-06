import { describe, expect, it } from "vitest";
import {
  BACKLOG_MS,
  HELD_LONG_MS,
  evaluateConditions,
  type ConditionInput,
  type ConditionKey,
  type DomainWindow,
} from "@/lib/metrics/conditions";
import { BASELINE_DAYS, DOWN_SHARE, MIN_ACTIVE_DAYS, MIN_DAILY_AVERAGE, UP_MULTIPLE } from "@/lib/metrics/volume";
import type { StallDetail, StallReason } from "@/lib/domains/guard";
import { EMPTY_COUNTS, type OutcomeCounts } from "@/lib/metrics/rates";

function input(overrides: Partial<ConditionInput> = {}): ConditionInput {
  return {
    days: 30,
    oldestDueMs: null,
    dueCount: 0,
    oldestHeldMs: null,
    heldCount: 0,
    queueFails: false,
    silentCount: 0,
    retryPressure: 1,
    previousRetryPressure: 1,
    domains: [],
    volumes: [],
    reputation: [],
    ...overrides,
  };
}

/** A domain with enough volume for its rates to be computed at all. */
function domain(
  overrides: Partial<OutcomeCounts> & {
    name?: string;
    stall?: DomainWindow["stall"];
    held?: DomainWindow["held"];
  } = {},
): DomainWindow {
  const { name = "example.com", stall = null, held = null, ...counts } = overrides;
  return {
    domainId: `dom_${name}`,
    domainName: name,
    counts: { ...EMPTY_COUNTS, ...counts } as OutcomeCounts,
    stall,
    held,
  };
}

function stall(reason: StallReason, detail: Partial<StallDetail> = {}): { reason: StallReason; detail: StallDetail } {
  return {
    reason,
    detail: { metric: "bounce", count: 0, denominator: 0, rate: null, previousRate: null, threshold: 0, ...detail },
  };
}

function keys(conditions: { key: ConditionKey }[]): ConditionKey[] {
  return conditions.map((condition) => condition.key);
}

describe("a healthy organization", () => {
  it("gets nothing — no reassurance panel", () => {
    expect(
      evaluateConditions(
        input({ domains: [domain({ total: 500, delivered: 500 })] }),
      ),
    ).toEqual([]);
  });
});

describe("the backlog condition", () => {
  it("stays quiet for a burst that's moving", () => {
    expect(keys(evaluateConditions(input({ oldestDueMs: BACKLOG_MS - 1, dueCount: 400 })))).not.toContain("backlog");
  });

  it("fires when the oldest due message has been waiting too long", () => {
    expect(keys(evaluateConditions(input({ oldestDueMs: BACKLOG_MS + 1, dueCount: 3 })))).toContain("backlog");
  });

  it("says nothing is lost, because that's the question a delay raises", () => {
    const [condition] = evaluateConditions(input({ oldestDueMs: 20 * 60_000, dueCount: 3 }));
    expect(condition?.body).toContain("They send when the queue clears");
  });
});

describe("the held condition", () => {
  it("stays quiet when nothing is held, or the hold is recent", () => {
    expect(keys(evaluateConditions(input()))).not.toContain("held");
    expect(keys(evaluateConditions(input({ oldestHeldMs: HELD_LONG_MS - 1, heldCount: 4 })))).not.toContain("held");
  });

  it("names the oldest held message's age once the hold runs long", () => {
    const [condition] = evaluateConditions(input({ oldestHeldMs: 52 * 3_600_000, heldCount: 5 }));
    expect(condition).toMatchObject({ key: "held", title: "Held mail is 2 days old", links: [{ href: "/messages?preset=held", label: "See held messages" }] });
    expect(condition?.body).toBe("5 messages held. They send when the hold lifts, however old they are by then.");
  });

  it("leaves mail a stalled domain holds to that domain's callout", () => {
    const held = { count: 2, oldestMs: 19 * 86_400_000 };
    const conditions = evaluateConditions(
      input({
        oldestHeldMs: held.oldestMs,
        heldCount: 2,
        domains: [domain({ total: 3, complained: 1, stall: stall("complaint_count"), held })],
      }),
    );
    expect(keys(conditions)).not.toContain("held");
    expect(conditions.find((condition) => condition.key === "domain_stalled")?.body).toContain(
      "2 queued messages held, the oldest for 19 days.",
    );
  });

  it("still fires for held mail no stall explains", () => {
    const conditions = evaluateConditions(
      input({
        oldestHeldMs: 5 * 3_600_000,
        heldCount: 3,
        domains: [domain({ total: 3, stall: stall("bounce_count"), held: { count: 1, oldestMs: 3_600_000 } })],
      }),
    );
    expect(keys(conditions)).toContain("held");
  });
});

describe("the backlog condition under a suspension that fails the queue", () => {
  it("says the queued mail fails instead of promising it sends", () => {
    const [condition] = evaluateConditions(input({ oldestDueMs: 20 * 60_000, dueCount: 3, queueFails: true }));
    expect(condition).toMatchObject({ key: "backlog", title: "Queued mail will fail", tone: "danger" });
    expect(condition?.body).toBe("3 messages queued while sending is suspended. They fail instead of sending.");
    expect(condition?.body).not.toContain("They send");
  });

  it("stays quiet when nothing is queued", () => {
    expect(keys(evaluateConditions(input({ queueFails: true })))).not.toContain("backlog");
  });
});

describe("reputation standing", () => {
  const finding = (standing: "watch" | "at_risk" | "paused") => ({
    kind: "bounce_rate" as const,
    standing,
    title: "Bounce rate on example.com is 2.20%",
    body: "2.20% of 1,000 resolved messages in 7 days.",
    action: "Remove addresses that bounce.",
  });

  it("raises a warning for watch and a danger for at risk, linking to the domain's reputation", () => {
    const conditions = evaluateConditions(
      input({
        reputation: [
          { type: "domain", id: "dom_a", standing: "watch", findings: [finding("watch")] },
          { type: "domain", id: "dom_b", standing: "at_risk", findings: [finding("at_risk")] },
        ],
      }),
    );
    expect(conditions.map((condition) => [condition.key, condition.tone, condition.links.at(-1)?.href])).toEqual([
      ["domain_reputation", "danger", "/domains/dom_b/reputation"],
      ["domain_reputation", "warning", "/domains/dom_a/reputation"],
    ]);
    expect(conditions[0]?.body).toBe("Remove addresses that bounce.");
  });

  it("stays quiet for healthy and leaves paused to the stall and suspension banners", () => {
    const conditions = evaluateConditions(
      input({
        reputation: [
          { type: "domain", id: "dom_a", standing: "healthy", findings: [] },
          { type: "domain", id: "dom_b", standing: "paused", findings: [finding("paused")] },
        ],
      }),
    );
    expect(conditions).toEqual([]);
  });

  it("links an organization finding AWS raised to the reputation page of a domain it covers", () => {
    const aws = { kind: "provider_finding" as const, metric: "bounce" as const, standing: "at_risk" as const, title: "AWS flagged bounces on Acme", body: "", action: "Fix it." };
    const conditions = evaluateConditions(
      input({
        domains: [{ ...domain(), domainId: "dom_a" }],
        reputation: [
          { type: "organization", id: "org_a", standing: "at_risk", findings: [{ ...aws, domainId: "dom_a" }] },
          { type: "organization", id: "org_b", standing: "watch", findings: [aws] },
        ],
      }),
    );
    expect(conditions.map((condition) => condition.links.map((link) => link.label))).toEqual([
      ["See bounced messages", "See reputation"],
      ["See bounced messages"],
    ]);
    expect(conditions[0]?.links.map((link) => link.href)).toEqual([
      "/messages?domain=example.com&status=bounced&days=7",
      "/domains/dom_a/reputation",
    ]);
  });

  it("links a bounce finding on the organization to bounced messages across every domain, then the domains", () => {
    const [condition] = evaluateConditions(
      input({
        reputation: [
          {
            type: "organization",
            id: "org_a",
            standing: "watch",
            findings: [{ ...finding("watch"), title: "Bounce rate on Acme is 1.89%", metric: "bounce" }],
          },
        ],
      }),
    );
    expect(condition?.links).toEqual([
      { href: "/messages?status=bounced&days=7", label: "See bounced messages" },
      { href: "/domains", label: "See domains" },
    ]);
  });

  it("links a complaint finding to complained messages on its domain", () => {
    const [condition] = evaluateConditions(
      input({
        domains: [domain()],
        reputation: [
          {
            type: "domain",
            id: "dom_example.com",
            standing: "at_risk",
            findings: [{ ...finding("at_risk"), kind: "complaint_rate", metric: "complaint" }],
          },
        ],
      }),
    );
    expect(condition?.links[0]).toEqual({
      href: "/messages?domain=example.com&status=complained&days=7",
      label: "See complained messages",
    });
  });

  it("scopes a volume finding to the last day, and blocklist findings keep only the reputation page", () => {
    const base = { standing: "watch" as const, title: "t", body: "b", action: "a" };
    const [spike, listed] = evaluateConditions(
      input({
        domains: [domain()],
        reputation: [
          { type: "domain", id: "dom_example.com", standing: "watch", findings: [{ ...base, kind: "volume_spike" }] },
          { type: "domain", id: "dom_other", standing: "watch", findings: [{ ...base, kind: "blocklist_listing" }] },
        ],
      }),
    );
    expect(spike?.links.map((link) => link.href)).toEqual([
      "/messages?domain=example.com&days=1",
      "/domains/dom_example.com/reputation",
    ]);
    expect(listed?.links).toEqual([{ href: "/domains/dom_other/reputation", label: "See reputation" }]);
  });
});

describe("a stalled domain", () => {
  it("fires ahead of, and independent from, the reputation limit cards", () => {
    const conditions = evaluateConditions(
      input({ domains: [domain({ total: 10, delivered: 8, bounced: 2, stall: stall("bounce_count") })] }),
    );
    expect(keys(conditions)).toContain("domain_stalled");
  });

  it("says the domain's name and the reason, not a generic notice", () => {
    const [condition] = evaluateConditions(
      input({
        domains: [
          domain({
            total: 10,
            bounced: 3,
            stall: stall("bounce_count", { count: 3, denominator: 4 }),
          }),
        ],
      }),
    );
    expect(condition?.title).toContain("example.com");
    expect(condition?.body).toContain("3 bounces on 4 sends");
  });

  it("stays quiet for a domain nothing has stalled", () => {
    const conditions = evaluateConditions(input({ domains: [domain({ total: 500, delivered: 500 })] }));
    expect(keys(conditions)).not.toContain("domain_stalled");
  });
});

describe("a domain's volume against its last two weeks", () => {
  const steady = (perDay: number) => Array.from({ length: BASELINE_DAYS }, () => perDay);
  const volume = (lastDay: number, baseline: number[]) =>
    evaluateConditions(input({ volumes: [{ domainName: "pouch.email", lastDay, baseline }] }));

  it("never fires for a domain sending a few a day, whatever it does", () => {
    for (const lastDay of [0, 1, 30, 300]) expect(volume(lastDay, steady(3))).toEqual([]);
  });

  it("says a busy domain stopped, as information", () => {
    const [condition] = volume(0, steady(300));
    expect(condition).toMatchObject({
      key: "domain_volume",
      tone: "info",
      title: "pouch.email stopped sending",
      body: "None sent in the last day, against about 300 a day over the previous 14 days.",
    });
    expect(condition?.links).toEqual([{ href: "/messages?domain=pouch.email&days=15", label: "See earlier messages" }]);
  });

  it("fires down under a quarter of the average, and not at it", () => {
    expect(volume(100 * DOWN_SHARE - 1, steady(100))[0]?.title).toBe("pouch.email is sending less");
    expect(volume(100 * DOWN_SHARE, steady(100))).toEqual([]);
    expect(volume(12, steady(300))[0]?.body).toBe("12 sent in the last day, against about 300 a day over the previous 14 days.");
  });

  it("fires up past three times the average, and not at it", () => {
    expect(volume(100 * UP_MULTIPLE + 1, steady(100))[0]?.title).toBe("pouch.email is sending more");
    expect(volume(100 * UP_MULTIPLE, steady(100))).toEqual([]);
    expect(volume(1240, steady(287))[0]?.body).toBe("1,240 sent in the last day, against about 290 a day over the previous 14 days.");
  });

  it("stays quiet just under the minimum average", () => {
    expect(volume(0, steady(MIN_DAILY_AVERAGE - 1))).toEqual([]);
  });

  it("stays quiet without enough days of history", () => {
    const young = [...Array.from({ length: MIN_ACTIVE_DAYS - 1 }, () => 400), ...Array.from({ length: BASELINE_DAYS - MIN_ACTIVE_DAYS + 1 }, () => 0)];
    expect(volume(0, young)).toEqual([]);
    expect(volume(5000, young)).toEqual([]);
    expect(volume(0, steady(300).slice(1))).toEqual([]);
  });

  it("stays quiet for a day inside the range the baseline already covered", () => {
    // Weekdays at 400, weekends at 20: a Saturday at 20 is normal.
    const weekly = Array.from({ length: BASELINE_DAYS }, (_, day) => (day % 7 < 2 ? 20 : 400));
    expect(volume(20, weekly)).toEqual([]);
    expect(volume(0, weekly)[0]?.title).toBe("pouch.email stopped sending");
  });

  it("leaves a jump to the reputation warning that already names it", () => {
    const spike = { kind: "volume_spike" as const, standing: "watch" as const, title: "Volume on pouch.email jumped 6×", body: "", action: "" };
    const conditions = evaluateConditions(
      input({
        volumes: [{ domainName: "pouch.email", lastDay: 1800, baseline: steady(300) }],
        reputation: [{ type: "domain", id: "dom_pouch", name: "pouch.email", standing: "watch", findings: [spike] }],
      }),
    );
    expect(keys(conditions)).toEqual(["domain_reputation"]);
  });

  it("sits after warnings", () => {
    const conditions = evaluateConditions(
      input({ volumes: [{ domainName: "pouch.email", lastDay: 0, baseline: steady(300) }], retryPressure: 1.6, previousRetryPressure: 1 }),
    );
    expect(conditions.map((condition) => condition.tone)).toEqual(["warning", "info"]);
  });
});

describe("links to the rows behind a condition", () => {
  it("sends retry pressure to the retried messages in the window", () => {
    const [condition] = evaluateConditions(input({ retryPressure: 1.6, previousRetryPressure: 1.0 }));
    expect(condition?.links).toEqual([{ href: "/messages?retried=1&days=30", label: "See retried messages" }]);
  });

  it("sends a stalled domain to its held messages, then the domain page", () => {
    const [condition] = evaluateConditions(
      input({ domains: [domain({ total: 10, bounced: 3, stall: stall("bounce_count") })] }),
    );
    expect(condition?.links.map((link) => link.href)).toEqual([
      "/messages?preset=held&domain=example.com",
      "/domains/dom_example.com",
    ]);
  });
});

describe("retry pressure", () => {
  it("fires on a material rise", () => {
    expect(keys(evaluateConditions(input({ retryPressure: 1.6, previousRetryPressure: 1.0 })))).toContain(
      "retry_pressure",
    );
  });

  it("ignores noise", () => {
    expect(keys(evaluateConditions(input({ retryPressure: 1.1, previousRetryPressure: 1.0 })))).not.toContain(
      "retry_pressure",
    );
  });

  it("has nothing to compare against in a first window", () => {
    expect(keys(evaluateConditions(input({ retryPressure: 3, previousRetryPressure: 0 })))).not.toContain(
      "retry_pressure",
    );
  });
});

describe("accepted then silent", () => {
  it("fires on messages the provider took and never spoke about again", () => {
    expect(keys(evaluateConditions(input({ silentCount: 4 })))).toContain("accepted_silent");
  });
});
