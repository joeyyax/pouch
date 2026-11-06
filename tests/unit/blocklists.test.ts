import { describe, expect, it } from "vitest";
import { classifyAnswer, normalizeDomain, queryName } from "@/lib/blocklists/lists";
import { extractLinkHosts } from "@/lib/blocklists/links";
import { blocklistFindings, evaluateStanding } from "@/lib/reputation/standing";
import { EMPTY_COUNTS } from "@/lib/metrics/rates";
import { DEFAULT_STALL_LINES } from "@/lib/domains/guard";

const KEY = "abcdefghijklmnopqrstuvwxyz";

describe("classifyAnswer", () => {
  it("reads NXDOMAIN as clear", () => {
    expect(classifyAnswer("dbl", [])).toEqual({ kind: "clear" });
  });

  it("reads DBL codes as listings with Spamhaus's reason", () => {
    expect(classifyAnswer("dbl", ["127.0.1.2"])).toMatchObject({ kind: "listed", code: "127.0.1.2", reason: "spam domain" });
    expect(classifyAnswer("dbl", ["127.0.1.104"])).toMatchObject({ kind: "listed", reason: "abused legit phish" });
  });

  it.each([
    ["127.255.255.252", "key_invalid"],
    ["127.255.255.254", "refused"],
    ["127.255.255.255", "rate_limited"],
    ["127.255.255.1", "refused"],
  ])("never reads %s as a listing", (code, error) => {
    expect(classifyAnswer("dbl", [code])).toEqual({ kind: "error", error, code });
    expect(classifyAnswer("zrd", [code])).toEqual({ kind: "error", error, code });
  });

  it("prefers the error when an answer mixes one with a listing code", () => {
    expect(classifyAnswer("dbl", ["127.0.1.2", "127.255.255.254"])).toMatchObject({ kind: "error", error: "refused" });
  });

  it("treats codes outside the documented set as errors", () => {
    expect(classifyAnswer("dbl", ["127.0.1.255"])).toMatchObject({ kind: "error", error: "unexpected_code" });
    expect(classifyAnswer("dbl", ["127.0.0.2"])).toMatchObject({ kind: "error", error: "unexpected_code" });
    expect(classifyAnswer("zrd", ["127.0.2.255"])).toMatchObject({ kind: "error", error: "unexpected_code" });
  });

  it("reads a ZRD code's last octet as the domain's age in hours", () => {
    expect(classifyAnswer("zrd", ["127.0.2.7"])).toMatchObject({ kind: "listed", ageHours: 7 });
  });
});

describe("queryName", () => {
  it("puts the domain under the key and the list's DQS zone", () => {
    expect(queryName("dbl", "Example.COM.", KEY)).toBe(`example.com.${KEY}.dbl.dq.spamhaus.net`);
    expect(queryName("zrd", "mail.example.com", KEY)).toBe(`mail.example.com.${KEY}.zrd.dq.spamhaus.net`);
  });

  it("refuses names and keys that would change the query", () => {
    expect(queryName("dbl", "example.com", "bad.key.with.dots")).toBeNull();
    expect(queryName("dbl", "10.0.0.1", KEY)).toBeNull();
    expect(queryName("dbl", "localhost", KEY)).toBeNull();
    expect(normalizeDomain("exa mple.com")).toBeNull();
  });
});

describe("extractLinkHosts", () => {
  it("returns distinct link hosts, skipping the sender's own domain and non-web links", () => {
    const html = `
      <a href="https://Shop.Example.net/a?x=1&amp;y=2">one</a>
      <a href='http://shop.example.net/b'>again</a>
      <a href="https://news.example.com/">own subdomain</a>
      <a href="mailto:hi@example.org">mail</a>
      <a href="https://192.0.2.1/">ip</a>
      <img src="https://images.example.org/x.png">`;
    expect(extractLinkHosts(html, ["example.com"])).toEqual(["shop.example.net"]);
  });

  it("stops at ten hosts", () => {
    const html = Array.from({ length: 15 }, (_, i) => `<a href="https://h${i}.example.net">x</a>`).join("");
    expect(extractLinkHosts(html, [])).toHaveLength(10);
  });
});

describe("blocklist findings", () => {
  const base = { subject: "example.com", counts: EMPTY_COUNTS, previousCounts: EMPTY_COUNTS, signals: null, pause: null, lines: DEFAULT_STALL_LINES };

  it("puts a DBL-listed sending domain at risk and says how to request removal", () => {
    const result = evaluateStanding({
      ...base,
      blocklists: [{ domain: "example.com", source: "sending", list: "dbl", code: "127.0.1.2", reason: "spam domain" }],
    });
    expect(result.standing).toBe("at_risk");
    expect(result.findings[0]).toMatchObject({ kind: "blocklist_listing", title: "example.com is on Spamhaus DBL" });
    expect(result.findings[0]?.body).toContain("spam domain (127.0.1.2)");
    expect(result.findings[0]?.action).toContain("https://check.spamhaus.org");
  });

  it("keeps a ZRD-only listing at watch", () => {
    const [finding] = blocklistFindings("example.com", [
      { domain: "example.com", source: "sending", list: "zrd", code: "127.0.2.3", reason: "newly registered or newly active domain" },
    ]);
    expect(finding?.standing).toBe("watch");
    expect(finding?.action).not.toContain("check.spamhaus.org");
  });

  it("names linked domains and the messages that carried them", () => {
    const [finding] = blocklistFindings("example.com", [
      { domain: "bad.example.net", source: "link", list: "dbl", code: "127.0.1.4", reason: "phish domain", messages: 3 },
    ]);
    expect(finding).toMatchObject({
      kind: "linked_domain_listing",
      standing: "at_risk",
      title: "Mail from example.com links to a listed domain: bad.example.net",
    });
    expect(finding?.body).toContain("3 messages in 24 hours linked to bad.example.net (Spamhaus DBL: phish domain)");
  });

  it("stays healthy with no listings", () => {
    expect(evaluateStanding({ ...base, blocklists: [] }).standing).toBe("healthy");
  });
});
