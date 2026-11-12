import { describe, expect, it } from "vitest";
import { zoneFile } from "@/lib/dashboard/views/domains";
import { markMerges, spfLookups, spfMechanisms, spfMergeGuidance, withSpfMechanisms } from "@/lib/domains/spf";
import { buildAdapter } from "@/lib/providers/adapters";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { at } from "../at";

const apexSpf: ProposedDnsRecord = { type: "TXT", name: "example.org", value: "v=spf1 include:mailpace.com ~all", required: false };
const dkim: ProposedDnsRecord = { type: "CNAME", name: "jy1a2b._domainkey.example.org", value: "jy1a2b.dkim.mailpace.com", required: true };
const subdomainSpf: ProposedDnsRecord = { type: "TXT", name: "mail.scope.example", value: "v=spf1 include:amazonses.com ~all", required: false };

describe("spfMechanisms", () => {
  it("drops the version tag and the all qualifier, keeping what merges", () => {
    expect(spfMechanisms("v=spf1 include:mailpace.com ~all")).toEqual(["include:mailpace.com"]);
    expect(spfMechanisms("v=spf1 ip4:203.0.113.0/24 include:_spf.google.com -all")).toEqual([
      "ip4:203.0.113.0/24",
      "include:_spf.google.com",
    ]);
  });
});

describe("spfLookups", () => {
  it("counts only the mechanisms a receiver resolves", () => {
    expect(spfLookups(spfMechanisms("v=spf1 ip4:203.0.113.9 ip6:2001:db8::1 ~all"))).toBe(0);
    expect(spfLookups(spfMechanisms("v=spf1 include:mailpace.com ~all"))).toBe(1);
    expect(spfLookups(spfMechanisms("v=spf1 a mx include:one.example -include:two.example exists:%{i}.x ~all"))).toBe(5);
    expect(spfLookups(spfMechanisms("v=spf1 redirect=_spf.example.com"))).toBe(1);
  });
});

describe("withSpfMechanisms", () => {
  it("adds ahead of the all term", () => {
    expect(withSpfMechanisms("v=spf1 include:_spf.google.com ~all", "include:amazonses.com")).toBe(
      "v=spf1 include:_spf.google.com include:amazonses.com ~all",
    );
  });

  it("appends to a record with no all term", () => {
    expect(withSpfMechanisms("v=spf1 include:_spf.google.com", "include:amazonses.com")).toBe("v=spf1 include:_spf.google.com include:amazonses.com");
  });
});

describe("markMerges", () => {
  it("marks an SPF record at the domain's own name, where the domain may already have one", () => {
    expect(at(markMerges([apexSpf], "example.org"), 0).merge).toBe("spf");
  });

  it("leaves an SPF record on a subdomain nothing else occupies alone, as SES's is", () => {
    expect(at(markMerges([subdomainSpf], "scope.example"), 0).merge).toBeUndefined();
  });

  it("leaves records that aren't SPF alone", () => {
    expect(at(markMerges([dkim], "example.org"), 0).merge).toBeUndefined();
    expect(
      at(markMerges([{ type: "TXT", name: "example.org", value: "google-site-verification=abc", required: false }], "example.org"), 0).merge,
    ).toBeUndefined();
  });
});

describe("spfMergeGuidance", () => {
  it("says to add the mechanism to the existing record, and names the consequence of a second", () => {
    const guidance = spfMergeGuidance(apexSpf);
    expect(guidance.mechanisms).toBe("include:mailpace.com");
    expect(guidance.note).toContain("example.org can have only one SPF record");
    expect(guidance.note).toContain("add include:mailpace.com to the record it has");
    expect(guidance.note).toContain("fails SPF for all of this domain's mail");
  });

  it("prices the mechanism against the 10-lookup limit", () => {
    expect(spfMergeGuidance(apexSpf).cost).toBe(
      "include:mailpace.com costs 1 of the 10 DNS lookups SPF allows, so a record already at 10 needs one removed first.",
    );
  });

  it("says nothing about lookups when the record costs none", () => {
    expect(spfMergeGuidance({ type: "TXT", name: "example.org", value: "v=spf1 ip4:203.0.113.9 ~all", required: false }).cost).toBeNull();
  });
});

describe("zoneFile", () => {
  it("warns above a record that merges, so copy-all can't be pasted into a second SPF record", () => {
    expect(zoneFile(markMerges([apexSpf], "example.org"))).toBe(
      '; example.org can have only one SPF record. Merge this into the record it has rather than adding a second.\nexample.org. IN TXT "v=spf1 include:mailpace.com ~all"',
    );
  });

  it("leaves every other record as a plain line", () => {
    expect(zoneFile([dkim, subdomainSpf])).toBe(
      'jy1a2b._domainkey.example.org. IN CNAME jy1a2b.dkim.mailpace.com.\nmail.scope.example. IN TXT "v=spf1 include:amazonses.com ~all"',
    );
  });
});

describe("mailpace domain records", () => {
  it("marks the apex SPF record it returns, and marks nothing else", async () => {
    const provider = buildAdapter("mailpace", { serverToken: "token", organizationToken: "org" });
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: 42,
          dkim_host: "jy1a2b._domainkey.example.org",
          dkim_value: "jy1a2b.dkim.mailpace.com",
          return_path_domain: "psrp.example.org",
          return_path_value: "rp.mailpace.com",
          spf_value: "v=spf1 include:mailpace.com ~all",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    try {
      const created = await provider.domain.create("example.org");
      const spf = created.records.find((record) => record.name === "example.org");
      expect(spf?.merge).toBe("spf");
      expect(created.records.filter((record) => record.merge !== undefined)).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
