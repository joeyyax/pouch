import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { at } from "../at";

const zone = vi.hoisted(() => new Map<string, string[]>());
vi.mock("node:dns/promises", () => {
  class Resolver {
    setServers() {}
    cancel() {}
    async resolveTxt(name: string): Promise<string[][]> {
      if (name === "_dmarc.slow.example") throw Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" });
      const records = zone.get(name);
      if (!records) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return records.map((record) => [record]);
    }
  }
  return { Resolver };
});

const { resetDnsCheckCache } = await import("@/lib/domains/dns-check");
const { computeDnsPlan } = await import("@/lib/domains/dns-plan");
const dmarc = await import("@/lib/domains/dmarc");

const sesRecords: ProposedDnsRecord[] = [
  { type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", required: true },
  { type: "MX", name: "mail.example.com", value: "feedback-smtp.us-west-2.amazonses.com", priority: 10, required: false },
  { type: "TXT", name: "mail.example.com", value: "v=spf1 include:amazonses.com ~all", required: false },
];

function parsed(value: string) {
  const result = dmarc.parseDmarc(value);
  if (!result.ok) throw new Error(`expected ${value} to parse: ${result.reason}`);
  return result.tags;
}

beforeEach(() => {
  zone.clear();
  resetDnsCheckCache();
});

describe("parseDmarc", () => {
  it("reads every tag", () => {
    expect(
      parsed("v=DMARC1; p=quarantine; sp=reject; pct=25; rua=mailto:a@example.com!10m,mailto:b@example.com; ruf=mailto:f@example.com; adkim=s; aspf=r"),
    ).toEqual({
      policy: "quarantine",
      subdomainPolicy: "reject",
      percent: 25,
      rua: ["mailto:a@example.com", "mailto:b@example.com"],
      ruf: ["mailto:f@example.com"],
      adkim: "strict",
      aspf: "relaxed",
    });
  });

  it("defaults pct to 100 and both alignments to relaxed", () => {
    expect(parsed("v=DMARC1; p=none;")).toMatchObject({ percent: 100, adkim: "relaxed", aspf: "relaxed", rua: [], ruf: [], subdomainPolicy: null });
  });

  it("tolerates case and spacing around tags", () => {
    expect(parsed("V = DMARC1 ;P = Reject ; ADKIM = S")).toMatchObject({ policy: "reject", adkim: "strict" });
  });

  it("treats a record with report addresses and no usable p as p=none", () => {
    expect(parsed("v=DMARC1; p=bogus; rua=mailto:a@example.com").policy).toBe("none");
  });

  it("refuses a record with no usable p and nowhere to report", () => {
    expect(dmarc.parseDmarc("v=DMARC1; pct=50")).toEqual({ ok: false, reason: "p is missing or isn't none, quarantine or reject" });
  });

  it("refuses a part that isn't a tag", () => {
    expect(dmarc.parseDmarc("v=DMARC1; p=none; reject")).toMatchObject({ ok: false });
  });

  it("refuses a record that doesn't start with the version tag", () => {
    expect(dmarc.parseDmarc("p=none; v=DMARC1")).toMatchObject({ ok: false });
  });
});

describe("the recommended record", () => {
  it("is optional, so a missing one never gates verification or the reconciliation plan", () => {
    const recommended = dmarc.recommendedDmarc("example.com");
    expect(recommended).toEqual({ type: "TXT", name: "_dmarc.example.com", value: "v=DMARC1; p=none;", required: false });
    const records = dmarc.withDmarc(sesRecords, "example.com");
    expect(records).toHaveLength(sesRecords.length + 1);
    expect(computeDnsPlan(records, []).map((step) => step.record.name)).toEqual(["abc._domainkey.example.com"]);
  });

  it("isn't added twice when the list already has a record at that name", () => {
    const own: ProposedDnsRecord = { type: "TXT", name: "_dmarc.example.com", value: "v=DMARC1; p=reject;", required: false };
    expect(dmarc.withDmarc([...sesRecords, own], "example.com")).toEqual([...sesRecords, own]);
  });
});

describe("readDmarc", () => {
  it("reports no record as missing and recommends one", async () => {
    const result = dmarc.describeDmarc("example.com", await dmarc.readDmarc("example.com"), sesRecords);
    expect(result.status).toBe("missing");
    expect(result.findings).toEqual([expect.objectContaining({ kind: "missing", severity: "problem" })]);
    expect(dmarc.dmarcBlocksBulk(result)).toBe(true);
  });

  it("flags more than one record and reads no policy from them", async () => {
    zone.set("_dmarc.example.com", ["v=DMARC1; p=none;", "v=DMARC1; p=reject;", "v=spf1 -all"]);
    const result = dmarc.describeDmarc("example.com", await dmarc.readDmarc("example.com"), sesRecords);
    expect(result).toMatchObject({ status: "multiple", policy: null, record: null });
    expect(result.findings).toEqual([expect.objectContaining({ kind: "multiple_records", message: expect.stringContaining("2 DMARC records") })]);
  });

  it("flags a record it can't parse", async () => {
    zone.set("_dmarc.example.com", ["v=DMARC1; pct=50"]);
    const result = dmarc.describeDmarc("example.com", await dmarc.readDmarc("example.com"), sesRecords);
    expect(result).toMatchObject({ status: "invalid", record: "v=DMARC1; pct=50" });
    expect(result.findings[0]).toMatchObject({ kind: "unparseable", severity: "problem" });
  });

  it("notes p=none as monitoring only and reports its report addresses", async () => {
    zone.set("_dmarc.example.com", ["v=DMARC1; p=none; rua=mailto:reports@example.com"]);
    const result = dmarc.describeDmarc("example.com", await dmarc.readDmarc("example.com"), sesRecords);
    expect(result).toMatchObject({ status: "found", policy: "none", rua: ["mailto:reports@example.com"], source: "domain" });
    expect(result.findings).toEqual([expect.objectContaining({ kind: "monitoring_only", severity: "note" })]);
    expect(dmarc.dmarcBlocksBulk(result)).toBe(false);
  });

  it("raises no finding for an enforcing policy that aligns", async () => {
    zone.set("_dmarc.example.com", ["v=DMARC1; p=reject;"]);
    expect(dmarc.describeDmarc("example.com", await dmarc.readDmarc("example.com"), sesRecords).findings).toEqual([]);
  });

  it("reads the organizational domain's record for a subdomain with none, and applies sp", async () => {
    zone.set("_dmarc.example.co.uk", ["v=DMARC1; p=reject; sp=none"]);
    const lookup = await dmarc.readDmarc("mail.example.co.uk");
    expect(lookup).toMatchObject({ host: "_dmarc.example.co.uk", source: "organizational" });
    const result = dmarc.describeDmarc("mail.example.co.uk", lookup, []);
    expect(result).toMatchObject({ policy: "reject", subdomain_policy: "none", source: "organizational" });
    expect(result.findings.map((finding) => finding.kind)).toEqual(["monitoring_only"]);
  });

  it("prefers the domain's own record over its organizational domain's", async () => {
    zone.set("_dmarc.mail.example.com", ["v=DMARC1; p=quarantine"]);
    zone.set("_dmarc.example.com", ["v=DMARC1; p=none"]);
    expect(await dmarc.readDmarc("mail.example.com")).toMatchObject({ host: "_dmarc.mail.example.com", source: "domain" });
  });

  it("reports an unanswered lookup as unresolved, which doesn't block bulk", async () => {
    const result = dmarc.describeDmarc("slow.example", await dmarc.readDmarc("slow.example"), []);
    expect(result.status).toBe("unresolved");
    expect(dmarc.dmarcBlocksBulk(result)).toBe(false);
  });
});

describe("alignment", () => {
  it("aligns a MAIL FROM subdomain under relaxed alignment and not under strict", () => {
    expect(dmarc.aligns("mail.example.com", "example.com", "relaxed")).toBe(true);
    expect(dmarc.aligns("mail.example.com", "example.com", "strict")).toBe(false);
    expect(dmarc.aligns("example.com", "example.com", "strict")).toBe(true);
    expect(dmarc.aligns("example.net", "example.com", "relaxed")).toBe(false);
  });

  it("uses the registrable domain, not the last two labels", () => {
    expect(dmarc.aligns("mail.example.co.uk", "example.co.uk", "relaxed")).toBe(true);
    expect(dmarc.aligns("other.co.uk", "example.co.uk", "relaxed")).toBe(false);
  });

  it("reads the signing and envelope domains from the setup's records", () => {
    expect(dmarc.authenticationDomains(sesRecords)).toEqual({ dkim: ["example.com"], spf: ["mail.example.com"] });
  });

  it("passes the default SES setup under relaxed alignment", () => {
    const alignment = dmarc.alignmentOf("example.com", sesRecords, { adkim: "relaxed", aspf: "relaxed" });
    expect(alignment).toMatchObject({ passes: true, dkim: { aligned: true }, spf: { aligned: true } });
  });

  it("passes the default SES setup under strict alignment through DKIM, and notes that SPF doesn't align", async () => {
    zone.set("_dmarc.example.com", ["v=DMARC1; p=reject; adkim=s; aspf=s"]);
    const result = dmarc.describeDmarc("example.com", await dmarc.readDmarc("example.com"), sesRecords);
    expect(result.alignment).toMatchObject({ passes: true, dkim: { aligned: true, mode: "strict" }, spf: { aligned: false, mode: "strict" } });
    expect(result.findings).toEqual([expect.objectContaining({ kind: "spf_not_aligned", severity: "note" })]);
  });

  it("fails when neither identity aligns", () => {
    const foreign: ProposedDnsRecord[] = [
      { type: "CNAME", name: "abc._domainkey.example.net", value: "abc.dkim.example.org", required: true },
      { type: "TXT", name: "bounce.example.net", value: "v=spf1 include:example.org ~all", required: false },
    ];
    const alignment = dmarc.alignmentOf("example.com", foreign, { adkim: "relaxed", aspf: "relaxed" });
    expect(alignment?.passes).toBe(false);
    const findings = dmarc.describeDmarc("example.com", { host: "_dmarc.example.com", source: "domain", records: ["v=DMARC1; p=none"] }, foreign).findings;
    expect(at(findings, 1)).toMatchObject({ kind: "alignment_fails", severity: "problem" });
  });

  it("has nothing to measure without DKIM or SPF records", () => {
    expect(dmarc.alignmentOf("example.com", [], { adkim: "relaxed", aspf: "relaxed" })).toBeNull();
  });
});
