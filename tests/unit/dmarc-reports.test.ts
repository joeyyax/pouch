/** DMARC aggregate reports (#298): unpacking, reading, classifying and the record a domain publishes. */
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { classifyRecord, providerIdentity } from "@/lib/dmarc/classify";
import { parseReportXml, ReportParseError, unpackAttachment, MAX_XML_BYTES, type ReportRecord } from "@/lib/dmarc/parse";
import { describeDmarc, withDmarc, withReportUri } from "@/lib/domains/dmarc";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { gzipped, reportXml, zipped } from "../dmarc-report-fixtures";

const NOW = new Date(Date.now() + 3_600_000);

function rejects(run: () => unknown, reason: RegExp): void {
  expect(run).toThrow(ReportParseError);
  expect(run).toThrow(reason);
}

describe("unpacking a report attachment", () => {
  it("reads the same report from a zip, a gzip and plain XML", () => {
    const xml = reportXml();
    const plain = parseReportXml(unpackAttachment(Buffer.from(xml)), NOW);
    expect(parseReportXml(unpackAttachment(zipped(xml)), NOW)).toEqual(plain);
    expect(parseReportXml(unpackAttachment(gzipped(xml)), NOW)).toEqual(plain);
    expect(plain.records).toHaveLength(1);
    expect(plain.records[0]).toMatchObject({ dkim: "pass", spf: "pass", count: 120 });
  });

  it("refuses a gzip that expands past the cap", () => {
    const bomb = gzipSync(Buffer.alloc(MAX_XML_BYTES + 1024, 0x20));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    rejects(() => unpackAttachment(bomb), /expands past/);
  });

  it("refuses a zip entry that expands past the cap", () => {
    const bomb = zipped(Buffer.alloc(MAX_XML_BYTES + 1024, 0x20));
    rejects(() => unpackAttachment(bomb), /expands past/);
  });

  it("refuses a zip with no XML in it, and one cut short", () => {
    rejects(() => unpackAttachment(zipped(reportXml(), "report.txt")), /no XML/);
    const whole = zipped(reportXml());
    rejects(() => unpackAttachment(whole.subarray(0, whole.length - 30)), /central directory|damaged|truncated/);
  });
});

describe("reading report XML", () => {
  it("reads the metadata, the published policy and each row", () => {
    const report = parseReportXml(
      reportXml({
        rows: [
          {
            ip: "203.0.113.9",
            count: 7,
            dkim: "fail",
            spf: "fail",
            envelopeFrom: "spoof.example.net",
            dkimResults: [{ domain: "spoof.example.net", selector: "s1", result: "pass" }],
            spfResults: [{ domain: "spoof.example.net", result: "pass" }],
          },
        ],
      }),
      NOW,
    );
    expect(report).toMatchObject({
      reporter: "google.com",
      reportId: "17283746592837465",
      policy: { domain: "example.com", p: "none", adkim: "r", pct: 100 },
      records: [
        {
          sourceIp: "203.0.113.9",
          count: 7,
          dkim: "fail",
          spf: "fail",
          headerFrom: "example.com",
          envelopeFrom: "spoof.example.net",
          dkimResults: [{ domain: "spoof.example.net", selector: "s1", result: "pass" }],
          spfResults: [{ domain: "spoof.example.net", scope: null, result: "pass" }],
        },
      ],
    });
    expect(report.end.getTime() - report.begin.getTime()).toBe(86_400_000);
  });

  it("reads a namespaced report", () => {
    const xml = reportXml().replace("<feedback>", '<feedback xmlns="urn:ietf:params:xml:ns:dmarc-2.0">');
    expect(parseReportXml(xml, NOW).records).toHaveLength(1);
  });

  it("refuses malformed XML, a DOCTYPE and anything missing what a report must carry", () => {
    rejects(() => parseReportXml(reportXml().replace("</feedback>", "</feedbak>"), NOW), /well-formed|feedback/);
    rejects(() => parseReportXml(`<!DOCTYPE lolz [<!ENTITY lol "lol">]>${reportXml().replace(/^<\?xml[^>]*>/, "")}`, NOW), /DOCTYPE/);
    rejects(() => parseReportXml(reportXml({ rows: [] }), NOW), /no records/);
    rejects(() => parseReportXml(reportXml().replace(/<report_id>[^<]*<\/report_id>/, ""), NOW), /report_id/);
    rejects(() => parseReportXml(reportXml().replace("<count>120</count>", "<count>-3</count>"), NOW), /count/);
    rejects(() => parseReportXml("<html><body>not a report</body></html>", NOW), /feedback/);
  });

  it("refuses a period that ends in the future or runs backwards", () => {
    const future = Math.floor(NOW.getTime() / 1000) + 3 * 86_400;
    rejects(() => parseReportXml(reportXml({ end: future }), NOW), /future/);
    rejects(() => parseReportXml(reportXml({ begin: 2_000_000_000, end: 1_900_000_000 }), NOW), /date range/);
  });
});

const sesRecords: ProposedDnsRecord[] = [
  { type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", required: true },
  { type: "MX", name: "mail.example.com", value: "feedback-smtp.us-west-2.amazonses.com", priority: 10, required: false },
  { type: "TXT", name: "mail.example.com", value: "v=spf1 include:amazonses.com ~all", required: false },
  { type: "TXT", name: "example.com", value: "v=spf1 include:_spf.google.com ~all", required: false },
  { type: "MX", name: "inbound.example.com", value: "inbound-smtp.us-west-2.amazonaws.com", priority: 10, required: false },
];

function row(overrides: Partial<ReportRecord>): ReportRecord {
  return {
    sourceIp: "198.51.100.1",
    count: 1,
    disposition: "none",
    dkim: "fail",
    spf: "fail",
    headerFrom: "example.com",
    envelopeFrom: null,
    dkimResults: [],
    spfResults: [],
    ...overrides,
  };
}

describe("who sent a row's mail", () => {
  const identity = providerIdentity("example.com", sesRecords, "inbound.example.com");

  it("reads the provider's DKIM key and envelope host from the records, never the apex or the inbound host", () => {
    expect(identity).toEqual({ dkim: [{ selector: "abc", domain: "example.com" }], envelopeHosts: ["mail.example.com"] });
  });

  it("is the provider when its DKIM key or envelope host passed", () => {
    expect(classifyRecord("example.com", row({ dkim: "pass", dkimResults: [{ domain: "example.com", selector: "abc", result: "pass" }] }), identity)).toBe("provider");
    expect(classifyRecord("example.com", row({ spfResults: [{ domain: "mail.example.com", scope: "mfrom", result: "pass" }] }), identity)).toBe("provider");
  });

  it("is forwarded when the provider's signature broke and SPF failed on the way", () => {
    const relayed = row({ dkimResults: [{ domain: "example.com", selector: "abc", result: "fail" }], spfResults: [{ domain: "lists.example.org", scope: "mfrom", result: "fail" }] });
    expect(classifyRecord("example.com", relayed, identity)).toBe("forwarded");
  });

  it("is another sender the domain authorizes when it passes DMARC without the provider", () => {
    const workspace = row({ dkim: "pass", dkimResults: [{ domain: "example.com", selector: "google", result: "pass" }] });
    expect(classifyRecord("example.com", workspace, identity)).toBe("other");
  });

  it("is forwarded when another sender's aligned signature broke", () => {
    const relayed = row({ dkimResults: [{ domain: "example.com", selector: "google", result: "fail" }] });
    expect(classifyRecord("example.com", relayed, identity)).toBe("forwarded");
  });

  it("is unauthenticated when nothing of the domain's is there and DMARC failed", () => {
    const spoof = row({ dkimResults: [{ domain: "spoof.example.net", selector: "s1", result: "pass" }], spfResults: [{ domain: "spoof.example.net", scope: "mfrom", result: "pass" }] });
    expect(classifyRecord("example.com", spoof, identity)).toBe("unauthenticated");
  });
});

describe("the domain's report address in its DMARC record", () => {
  const uri = "mailto:0a1b2c@reports.example.net";

  it("joins the recommended record when the service has one", () => {
    const record = withDmarc([], "example.com", uri).find((one) => one.name === "_dmarc.example.com");
    expect(record?.value).toBe(`v=DMARC1; p=none; rua=${uri};`);
    expect(withDmarc([], "example.com").at(-1)?.value).toBe("v=DMARC1; p=none;");
  });

  it("merges into a published record, keeping its policy and its other report addresses", () => {
    expect(withReportUri("v=DMARC1; p=reject; rua=mailto:dmarc@example.com; adkim=s", uri)).toBe(
      `v=DMARC1; p=reject; rua=mailto:dmarc@example.com,${uri}; adkim=s;`,
    );
    expect(withReportUri("v=DMARC1; p=quarantine; pct=50;", uri)).toBe(`v=DMARC1; p=quarantine; rua=${uri}; pct=50;`);
  });

  it("asks for the merged record only while the published one lacks the address", () => {
    const lookup = (record: string) => ({ host: "_dmarc.example.com", source: "domain" as const, records: [record] });
    const lacking = describeDmarc("example.com", lookup("v=DMARC1; p=reject;"), sesRecords, uri);
    expect(lacking.recommended).toBe(`v=DMARC1; p=reject; rua=${uri};`);
    expect(lacking.findings.map((finding) => finding.kind)).toContain("no_report_address");

    const carrying = describeDmarc("example.com", lookup(`v=DMARC1; p=reject; rua=${uri}`), sesRecords, uri);
    expect(carrying.recommended).toBeNull();
    expect(carrying.findings.map((finding) => finding.kind)).not.toContain("no_report_address");

    expect(describeDmarc("example.com", lookup("v=DMARC1; p=reject;"), sesRecords).recommended).toBeNull();
    expect(describeDmarc("example.com", { host: "_dmarc.example.com", source: "domain", records: [] }, sesRecords, uri).recommended).toBe(
      `v=DMARC1; p=none; rua=${uri};`,
    );
  });
});
