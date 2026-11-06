import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { digestMail, digestText } from "@/lib/mail/digest/copy";
import { renderSystemMail, SystemMail } from "@/lib/mail/template";
import type { DigestSummary } from "@/lib/mail/digest/metrics";
import type { DigestWindow } from "@/lib/mail/digest/cadence";
import { RATE_FLOOR } from "@/lib/metrics/rates";
import { DEFAULT_STALL_LINES, stallLines } from "@/lib/domains/guard";

const window: DigestWindow = {
  cadence: "daily",
  windowKey: "2026-09-15",
  since: new Date("2026-09-15T00:00:00Z"),
  until: new Date("2026-09-16T00:00:00Z"),
  previousSince: new Date("2026-09-14T00:00:00Z"),
  previousUntil: new Date("2026-09-15T00:00:00Z"),
};

function summary(overrides: Partial<DigestSummary>): DigestSummary {
  return {
    window,
    total: 0,
    previousTotal: 0,
    delivered: 0,
    bounced: 0,
    complained: 0,
    failed: 0,
    previous: { delivered: 0, bounced: 0, complained: 0, failed: 0 },
    buckets: [],
    providers: [],
    organizations: [],
    topBounceReasons: [],
    attention: { standingChanges: [], findings: [], stalledDomains: [], slowDomains: [], observations: [], suspended: [], webhooksExhausted: [], endpointsDisabled: [], failedSignIns: [] },
    inbound: { received: 0, spam: 0, dmarcFailed: 0, virus: 0 },
    growth: { organizations: 0, domainsVerified: 0, keys: 0, suppressions: 0 },
    lines: DEFAULT_STALL_LINES,
    ...overrides,
  };
}

describe("digestText: bounce and complaint lines use the shared resolved-messages denominator", () => {
  it("matches the rate the rest of the dashboard would show for the same counts", () => {
    // delivered+bounced (the old denominator) is 48; resolved() (+complained+failed) is 50 —
    // above the floor on both, but they disagree: 2/48 (4.2%) vs 2/50 (4.0%).
    const text = digestText(
      summary({ total: 50, delivered: 46, bounced: 2, complained: 1, failed: 1 }),
      "https://pouch.email/u/t",
    );

    expect(text).toContain("4.0% bounced");
    expect(text).toContain("2.00% complained");
    expect(text).not.toContain("4.2% bounced");
    expect(text).not.toContain("2.13% complained");
  });

  it("falls back to the count, not a percentage, below the floor", () => {
    const text = digestText(summary({ total: 3, delivered: 1, bounced: 1, complained: 1, failed: 0 }), "https://pouch.email/u/t");

    expect(text).toContain("1 bounced");
    expect(text).toContain("1 complained");
    expect(text).not.toMatch(/%\s*bounced/);
    expect(text).not.toMatch(/%\s*complained/);
  });

  it("shows a real percentage once there's enough resolved volume", () => {
    const text = digestText(
      summary({ total: RATE_FLOOR, delivered: RATE_FLOOR - 2, bounced: 2, complained: 0, failed: 0 }),
      "https://pouch.email/u/t",
    );

    expect(text).toContain("4.0% bounced");
  });
});

describe("digest: needs a look sits above the stats, or gives way to an all-clear", () => {
  const quiet = summary({ total: 50, delivered: 50 });
  const noisy = summary({ total: 50, delivered: 50, attention: { ...quiet.attention, suspended: [{ organizationId: "org_1", organization: "Acme" }] } });
  const render = (value: DigestSummary) => renderSystemMail(createElement(SystemMail, digestMail(value, "https://pouch.email/u/t")));

  it("shows one all-clear after the title, before the stats, and no empty heading", async () => {
    const { html, text } = await render(quiet);

    expect(text).toContain("[ok] All clear. Nothing needs a look this window.");
    expect(text).not.toContain("Needs a look");
    expect(text).not.toContain("Nothing needs a look.");
    expect(text.indexOf("All clear")).toBeLessThan(text.indexOf("Sent: "));
    expect(html).toContain("All clear. Nothing needs a look this window.");
    expect(html).not.toContain(">Needs a look<");
    expect(html.indexOf("All clear")).toBeLessThan(html.indexOf(">Sent<"));
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("All clear"));
  });

  it("moves the list above the stats and drops the all-clear", async () => {
    const { html, text } = await render(noisy);

    expect(text).toContain("Needs a look\n[!!] Acme was suspended");
    expect(text).not.toContain("All clear");
    expect(text.indexOf("Needs a look")).toBeLessThan(text.indexOf("Sent: "));
    expect(html).not.toContain("All clear");
    expect(html.indexOf(">Needs a look<")).toBeLessThan(html.indexOf(">Sent<"));
  });

  it("names a slow domain, by how much, and that it often comes before bounces", () => {
    const slow = {
      domainId: "dom_1",
      domain: "example.com",
      organizationId: "org_1",
      organization: "Acme",
      p90Ms: 240_000,
      baselineMs: 40_000,
      delivered: 900,
    };
    const text = digestText({ ...quiet, attention: { ...quiet.attention, slowDomains: [slow] } }, "u");

    expect(text).toContain(
      "example.com (Acme): the slowest tenth of messages took 4 minutes, against 40 seconds the 7 days before. Slow delivery often comes before bounces.",
    );
  });

  it("lists a targeted account under needs a look, by organization, without the address", () => {
    const observation = {
      organizationId: "org_1",
      organization: "Acme",
      key: "account_targeted",
      tone: "warning" as const,
      text: "one address got 14 password reset links in 24 hours. Someone may be targeting that account.",
      path: "/messages?sensitive=1&days=1",
    };
    const value = { ...quiet, attention: { ...quiet.attention, observations: [observation] } };
    const mail = digestMail(value, "u");

    expect(digestText(value, "u")).toContain(
      "Needs a look\n[!] Acme: one address got 14 password reset links in 24 hours. Someone may be targeting that account.",
    );
    expect(mail.preheader).toMatch(/: 1 thing needs a look\./);
  });

  it("lists a quiet tag under changes in volume, not needs a look", () => {
    const observation = {
      organizationId: "org_1",
      organization: "Acme",
      key: "tag_quiet",
      tone: "info" as const,
      text: "the order-confirmation tag went quiet. None sent in the last day, against about 320 a day over the previous 14 days.",
      path: "/messages?tag=order-confirmation&days=15",
    };
    const value = { ...quiet, attention: { ...quiet.attention, observations: [observation] } };
    const text = digestText(value, "u");

    expect(text).toContain(
      "Changes in volume\n[-] Acme: the order-confirmation tag went quiet. None sent in the last day, against about 320 a day over the previous 14 days.",
    );
    expect(text).toContain("All clear");
    expect(text.indexOf("Sent: ")).toBeLessThan(text.indexOf("Changes in volume"));
    expect(digestMail(value, "u").preheader).toMatch(/: all clear\./);
  });

  it("makes the preheader agree with the case", () => {
    expect(digestMail(quiet, "u").preheader).toMatch(/: all clear\. 50 sent/);
    expect(digestMail(noisy, "u").preheader).toMatch(/: 1 thing needs a look\. 50 sent/);
  });

  it("renders no heading without items", async () => {
    const bare = (await render(quiet)).text;
    for (const heading of ["By provider", "Top organizations", "Also this window", "Top bounce and complaint reasons"]) expect(bare).not.toContain(heading);
    expect((await render({ ...quiet, buckets: [] })).text).not.toContain("Sent by");
  });
});

describe("digest: all-clear never sits beside a warn or bad mark", () => {
  const row = (name: string, overrides: Partial<DigestSummary["providers"][number]>) => ({ id: name, name, total: 200, delivered: 200, bounced: 0, complained: 0, failed: 0, ...overrides });
  const healthy = { total: 1000, delivered: 1000, previousTotal: 900, previous: { delivered: 900, bounced: 0, complained: 0, failed: 0 } };
  const cases: [string, Partial<DigestSummary>][] = [
    ["healthy", healthy],
    ["a bad complaint rate and nothing else", { ...healthy, delivered: 990, complained: 10 }],
    ["a watch bounce rate", { ...healthy, delivered: 980, bounced: 20 }],
    ["failed outright", { ...healthy, delivered: 997, failed: 3 }],
    ["one bad provider", { ...healthy, providers: [row("Postmark", { delivered: 180, bounced: 20 }), row("SES", {})] }],
    ["one bad organization", { ...healthy, organizations: [row("Acme", { delivered: 190, complained: 10 })] }],
    ["delivery down with failures", { ...healthy, delivered: 940, failed: 60, previous: { delivered: 990, bounced: 0, complained: 0, failed: 0 } }],
  ];
  const marked = (html: string) => /pm-(mark-)?(warn|bad)/.test(html.replace(/<style>[\s\S]*?<\/style>/, ""));

  it.each(cases)("%s: all-clear shows only when nothing is marked", async (_name, overrides) => {
    const { html, text } = await renderSystemMail(createElement(SystemMail, digestMail(summary(overrides), "https://pouch.email/u/t")));
    const clear = text.includes("All clear");
    expect(clear).toBe(html.includes("All clear"));
    if (clear) {
      expect(marked(html)).toBe(false);
      expect(text).not.toMatch(/\[!!?\]/);
    } else {
      expect(text).toContain("Needs a look");
    }
  });

  it("stays clear on healthy numbers", () => {
    expect(digestText(summary(healthy), "u")).toContain("All clear");
  });

  it("folds a subject's metrics into one item that takes the worse tone", () => {
    const same = digestText(summary({ ...healthy, providers: [row("Postmark", { delivered: 177, bounced: 20, complained: 3 })] }), "u");
    expect(same).toContain("[!!] Postmark: bounce rate 10.0% and complaint rate 1.50%, at risk");
    expect(same.match(/Postmark:/g)).toHaveLength(1);

    const mixed = digestText(summary({ ...healthy, providers: [row("Postmark", { delivered: 194, bounced: 3, complained: 3 })] }), "u");
    expect(mixed).toContain("[!!] Postmark: bounce rate 1.5% on watch, complaint rate 1.50% at risk");
  });

  it("words each item as what it measured and where standing puts it, once per cause", () => {
    const steady = { delivered: 891, bounced: 0, complained: 9, failed: 0 };
    const text = digestText(summary({ ...healthy, delivered: 990, complained: 10, previous: steady }), "u");
    expect(text).toContain("[!!] Complaint rate 1.00%, at risk");
    expect(text.match(/omplaint rate 1\.00%/g)).toHaveLength(1);
    expect(digestText(summary({ ...healthy, delivered: 997, failed: 3 }), "u")).toContain("3 messages failed outright");
  });

  it("counts below the rate floor the way the stall guard does", () => {
    const text = digestText(summary({ ...healthy, organizations: [row("Acme", { total: 12, delivered: 9, bounced: 3 })] }), "u");
    expect(text).toContain("[!!] Acme: 3 bounces, at risk");
  });

  it("reads a domain stalled at 3% as bad, not watch", () => {
    const text = digestText(summary({ ...healthy, organizations: [row("Acme", { delivered: 194, bounced: 6 })] }), "u");
    expect(text).toContain("[!!] Acme: bounce rate 3.0%, at risk");
  });

  it("[control] reads 1.5% as watch", () => {
    const text = digestText(summary({ ...healthy, organizations: [row("Acme", { delivered: 197, bounced: 3 })] }), "u");
    expect(text).toContain("[!] Acme: bounce rate 1.5%, on watch");
  });

  it("[control] stays clear at a steady 1% bounces under the default lines", () => {
    const steady = { delivered: 891, bounced: 9, complained: 0, failed: 0 };
    expect(digestText(summary({ ...healthy, delivered: 990, bounced: 10, previous: steady }), "u")).toContain("All clear");
  });

  it("reads the configured stall line", () => {
    const lines = stallLines({ stall_bounce_percent: 1.5, stall_complaint_percent: 0.05, stall_bounce_count: 3, stall_count_volume_floor: 10 });
    const steady = { delivered: 891, bounced: 9, complained: 0, failed: 0 };
    const text = digestText(summary({ ...healthy, delivered: 990, bounced: 10, previous: steady, lines }), "u");
    expect(text).toContain("[!] Bounce rate 1.0%, on watch");
  });
});
