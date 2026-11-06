import { describe, expect, it } from "vitest";
import { computeDnsCleanupPlan, previousAccountProvenance } from "@/lib/domains/dns-cleanup";
import type { DnsProviderRecordRow } from "@/lib/db/schema";
import type { ObservedDnsRecord, ProposedDnsRecord } from "@/lib/providers/adapters/types";

let nextId = 1;

function row(fields: Partial<DnsProviderRecordRow> & Pick<DnsProviderRecordRow, "type" | "name" | "writtenValue">): DnsProviderRecordRow {
  return {
    id: `dpr_${nextId++}`,
    organizationId: "org_test",
    domainId: "dom_test",
    dnsProviderAccountId: "dpa_test",
    providerId: null,
    zoneName: "example.com",
    appliedAt: new Date(),
    ...fields,
  } as DnsProviderRecordRow;
}

function observed(fields: Omit<ObservedDnsRecord, "id">): ObservedDnsRecord {
  return { ...fields, id: `rec_${nextId++}` };
}

describe("computeDnsCleanupPlan", () => {
  it("removes a plain record whose live value still matches exactly what was written", () => {
    const dkim = row({ type: "CNAME", name: "abc._domainkey.example.com", writtenValue: "abc.dkim.amazonses.com" });
    const live = observed({ type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com" });
    const [step] = computeDnsCleanupPlan([dkim], [live], []);
    expect(step).toMatchObject({ action: "delete", status: "removable" });
  });

  it("matches CNAME values case-insensitively and ignoring a trailing dot", () => {
    const dkim = row({ type: "CNAME", name: "abc._domainkey.example.com", writtenValue: "abc.dkim.amazonses.com" });
    const live = observed({ type: "CNAME", name: "ABC._domainkey.example.com.", value: "ABC.DKIM.amazonses.com." });
    const [step] = computeDnsCleanupPlan([dkim], [live], []);
    expect(step?.status).toBe("removable");
  });

  it("refuses a plain record that's been hand-edited since Pouch wrote it", () => {
    const dkim = row({ type: "CNAME", name: "abc._domainkey.example.com", writtenValue: "abc.dkim.amazonses.com" });
    const live = observed({ type: "CNAME", name: "abc._domainkey.example.com", value: "someone-elses-value.example.net" });
    const [step] = computeDnsCleanupPlan([dkim], [live], []);
    expect(step).toMatchObject({ action: "delete", status: "refused" });
  });

  it("refuses a record that's no longer published at all", () => {
    const dkim = row({ type: "CNAME", name: "abc._domainkey.example.com", writtenValue: "abc.dkim.amazonses.com" });
    const [step] = computeDnsCleanupPlan([dkim], [], []);
    expect(step).toMatchObject({ status: "refused" });
  });

  it("matches an MX record only when the domain's current required priority also agrees", () => {
    const mxRow = row({ type: "MX", name: "example.com", writtenValue: "feedback-smtp.us-east-1.amazonses.com" });
    const required: ProposedDnsRecord = { type: "MX", name: "example.com", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10, required: true };
    const wrongPriority = observed({ type: "MX", name: "example.com", value: "feedback-smtp.us-east-1.amazonses.com", priority: 20 });
    const [step] = computeDnsCleanupPlan([mxRow], [wrongPriority], [required]);
    expect(step).toMatchObject({ status: "refused" });

    const rightPriority = observed({ type: "MX", name: "example.com", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 });
    const [matched] = computeDnsCleanupPlan([mxRow], [rightPriority], [required]);
    expect(matched).toMatchObject({ status: "removable" });
  });

  it("subtracts only the mechanisms Pouch added from a merged SPF record, leaving the rest", () => {
    const spfRow = row({ type: "TXT", name: "example.com", writtenValue: "include:amazonses.com" });
    const live = observed({ type: "TXT", name: "example.com", value: "v=spf1 include:mailer.example.net include:amazonses.com ~all" });
    const [step] = computeDnsCleanupPlan([spfRow], [live], []);
    expect(step).toMatchObject({ action: "edit", status: "removable" });
    expect(step?.resultingValue).toBe("v=spf1 include:mailer.example.net ~all");
  });

  it("never deletes a merged SPF record that still holds mechanisms Pouch didn't add", () => {
    const spfRow = row({ type: "TXT", name: "example.com", writtenValue: "include:amazonses.com" });
    const live = observed({ type: "TXT", name: "example.com", value: "v=spf1 include:mailer.example.net include:amazonses.com ~all" });
    const [step] = computeDnsCleanupPlan([spfRow], [live], []);
    expect(step?.action).toBe("edit");
    expect(step?.resultingValue).toContain("include:mailer.example.net");
  });

  it("goes back to the record's base policy when nothing else was ever added", () => {
    const spfRow = row({ type: "TXT", name: "example.com", writtenValue: "include:amazonses.com" });
    const live = observed({ type: "TXT", name: "example.com", value: "v=spf1 include:amazonses.com ~all" });
    const [step] = computeDnsCleanupPlan([spfRow], [live], []);
    expect(step?.resultingValue).toBe("v=spf1 ~all");
  });

  it("refuses an SPF subtraction when a mechanism Pouch added is already gone", () => {
    const spfRow = row({ type: "TXT", name: "example.com", writtenValue: "include:amazonses.com" });
    const live = observed({ type: "TXT", name: "example.com", value: "v=spf1 include:mailer.example.net ~all" });
    const [step] = computeDnsCleanupPlan([spfRow], [live], []);
    expect(step).toMatchObject({ action: "edit", status: "refused" });
  });

  it("refuses a plain record when more than one record is published at its name now", () => {
    const dkim = row({ type: "CNAME", name: "abc._domainkey.example.com", writtenValue: "abc.dkim.amazonses.com" });
    const liveA = observed({ type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com" });
    const liveB = observed({ type: "CNAME", name: "abc._domainkey.example.com", value: "something-else.example.net" });
    const [step] = computeDnsCleanupPlan([dkim], [liveA, liveB], []);
    expect(step?.status).toBe("refused");
  });
});

describe("previousAccountProvenance", () => {
  const currentAccount = "acct_current";
  const previousAccount = "acct_previous";

  describe("null provider_id — falls back to the required-set inference", () => {
    it("excludes a row that's still part of what the domain requires today", () => {
      const oldMx = row({ type: "MX", name: "example.com", writtenValue: "feedback-smtp.us-east-1.amazonses.com" });
      const required: ProposedDnsRecord = { type: "MX", name: "example.com", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10, required: true };
      expect(previousAccountProvenance([oldMx], [required], currentAccount)).toEqual([]);
    });

    it("keeps a row whose (type, name) is no longer required at all — the previous account's own record", () => {
      const oldDkim = row({ type: "CNAME", name: "old._domainkey.example.com", writtenValue: "old.dkim.oldprovider.com" });
      const newDkim: ProposedDnsRecord = { type: "CNAME", name: "new._domainkey.example.com", value: "new.dkim.newprovider.com", required: true };
      expect(previousAccountProvenance([oldDkim], [newDkim], currentAccount)).toEqual([oldDkim]);
    });

    it("keeps a row whose value no longer matches what's required at the same name — the collision case", () => {
      const oldMx = row({ type: "MX", name: "example.com", writtenValue: "feedback-smtp.us-east-1.amazonses.com" });
      const newMx: ProposedDnsRecord = { type: "MX", name: "example.com", value: "inbound.newprovider.com", priority: 10, required: true };
      expect(previousAccountProvenance([oldMx], [newMx], currentAccount)).toEqual([oldMx]);
    });

    it("keeps a merged SPF row only when none of its mechanisms are required anymore, not when some still are", () => {
      const oldSpf = row({ type: "TXT", name: "example.com", writtenValue: "include:oldprovider.com" });
      const stillNeeded: ProposedDnsRecord = { type: "TXT", name: "example.com", value: "v=spf1 include:oldprovider.com ~all", required: true, merge: "spf" };
      expect(previousAccountProvenance([oldSpf], [stillNeeded], currentAccount)).toEqual([]);

      const noLongerNeeded: ProposedDnsRecord = { type: "TXT", name: "example.com", value: "v=spf1 include:newprovider.com ~all", required: true, merge: "spf" };
      expect(previousAccountProvenance([oldSpf], [noLongerNeeded], currentAccount)).toEqual([oldSpf]);
    });
  });

  describe("set provider_id — scoped directly, no inference", () => {
    it("excludes a row written by the domain's current account, even if it reads as stale by shape", () => {
      // Same shape as the "no longer required" case above, but this time the column says it's
      // the current account's record — direct scoping wins over the inference entirely.
      const currentDkim = row({
        type: "CNAME",
        name: "old._domainkey.example.com",
        writtenValue: "old.dkim.oldprovider.com",
        providerId: currentAccount,
      });
      const newDkim: ProposedDnsRecord = { type: "CNAME", name: "new._domainkey.example.com", value: "new.dkim.newprovider.com", required: true };
      expect(previousAccountProvenance([currentDkim], [newDkim], currentAccount)).toEqual([]);
    });

    it("keeps a row written by a different account, even if it still matches what's required by shape", () => {
      // A provider changing its required record set to something that happens to match another
      // provider's requirement is exactly the case a column, not an inference, has to get right.
      const previousMx = row({
        type: "MX",
        name: "example.com",
        writtenValue: "feedback-smtp.us-east-1.amazonses.com",
        providerId: previousAccount,
      });
      const required: ProposedDnsRecord = { type: "MX", name: "example.com", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10, required: true };
      expect(previousAccountProvenance([previousMx], [required], currentAccount)).toEqual([previousMx]);
    });
  });

  it("a mixed set: each row classifies on its own terms, column when present, inference when not", () => {
    const columnScopedCurrent = row({ type: "MX", name: "example.com", writtenValue: "mx.current.com", providerId: currentAccount });
    const columnScopedPrevious = row({ type: "TXT", name: "old._domainkey.example.com", writtenValue: "old.dkim.value", providerId: previousAccount });
    const inferredCurrent = row({ type: "CNAME", name: "abc._domainkey.example.com", writtenValue: "abc.dkim.amazonses.com" });
    const inferredPrevious = row({ type: "CNAME", name: "gone._domainkey.example.com", writtenValue: "gone.dkim.oldprovider.com" });

    const required: ProposedDnsRecord[] = [
      { type: "MX", name: "example.com", value: "mx.current.com", priority: 10, required: true },
      { type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", required: true },
    ];

    const previous = previousAccountProvenance(
      [columnScopedCurrent, columnScopedPrevious, inferredCurrent, inferredPrevious],
      required,
      currentAccount,
    );
    expect(previous).toEqual([columnScopedPrevious, inferredPrevious]);
  });
});
