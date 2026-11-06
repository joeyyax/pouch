import { describe, expect, it } from "vitest";
import { computeDnsPlan } from "@/lib/domains/dns-plan";
import type { ObservedDnsRecord, ProposedDnsRecord } from "@/lib/providers/adapters/types";

const cname: ProposedDnsRecord = { type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", required: true };
const optionalMx: ProposedDnsRecord = {
  type: "MX",
  name: "mail.example.com",
  value: "feedback-smtp.us-west-2.amazonses.com",
  priority: 10,
  required: false,
};
const spf: ProposedDnsRecord = {
  type: "TXT",
  name: "example.com",
  value: "v=spf1 include:amazonses.com ~all",
  required: true,
  merge: "spf",
};

let nextId = 1;
/** What a live zone read returns for a record: same type/name/value/priority, an id instead of `required`/`merge`. */
function observed(record: Omit<ProposedDnsRecord, "required" | "merge">): ObservedDnsRecord {
  return { ...record, id: `rec_${nextId++}` };
}

describe("computeDnsPlan", () => {
  it("skips records the domain doesn't require", () => {
    const steps = computeDnsPlan([optionalMx], []);
    expect(steps).toHaveLength(0);
  });

  it("marks a required record create when nothing lives at its name", () => {
    const [step] = computeDnsPlan([cname], []);
    expect(step).toMatchObject({ verdict: "create", observed: [] });
  });

  it("marks a required record already correct when the live value matches exactly", () => {
    const live = observed(cname);
    const [step] = computeDnsPlan([cname], [live]);
    expect(step?.verdict).toBe("already_correct");
  });

  it("matches CNAME values case-insensitively and ignoring a trailing dot", () => {
    const live = observed({ type: "CNAME", name: "ABC._domainkey.example.com.", value: "ABC.DKIM.amazonses.com." });
    const [step] = computeDnsPlan([cname], [live]);
    expect(step?.verdict).toBe("already_correct");
  });

  it("matches MX only when both the target and priority agree", () => {
    const wrongPriority = observed({ ...optionalMx, priority: 20 });
    const required: ProposedDnsRecord = { ...optionalMx, required: true };
    const [step] = computeDnsPlan([required], [wrongPriority]);
    expect(step?.verdict).toBe("conflict");
  });

  it("flags a conflict when something else entirely is at the name", () => {
    const live = observed({ ...cname, value: "someone-else.example.net" });
    const [step] = computeDnsPlan([cname], [live]);
    expect(step?.verdict).toBe("conflict");
    expect(step?.observed).toEqual([live]);
  });

  it("flags a conflict when more than one unrelated record already sits at the name", () => {
    const a = observed({ type: "TXT", name: "example.com", value: "google-site-verification=abc" });
    const b = observed({ type: "TXT", name: "example.com", value: "some-other-verification=def" });
    const [step] = computeDnsPlan([spf], [a, b]);
    expect(step?.verdict).toBe("conflict");
    expect(step?.observed).toHaveLength(2);
  });

  it("treats one matching value among several at the name as already correct — Route53's healthy multi-value record set", () => {
    const mx1 = { type: "MX" as const, name: "example.com", value: "mx1.example.net", priority: 10, required: true };
    const mx2 = { type: "MX" as const, name: "example.com", value: "mx2.example.net", priority: 20, required: true };
    const live = [observed(mx1), observed(mx2)];

    const steps = computeDnsPlan([mx1, mx2], live);
    expect(steps.map((step) => step.verdict)).toEqual(["already_correct", "already_correct"]);
    expect(steps[0]?.observed).toEqual([live[0]]);
    expect(steps[1]?.observed).toEqual([live[1]]);
  });

  it("still refuses a value not among several already published at the name — adding a new one needs a read-modify-write no adapter does", () => {
    const mx1 = { type: "MX" as const, name: "example.com", value: "mx1.example.net", priority: 10, required: true };
    const mx2 = { type: "MX" as const, name: "example.com", value: "mx2.example.net", priority: 20, required: true };
    const mx3 = { type: "MX" as const, name: "example.com", value: "mx3.example.net", priority: 30, required: true };
    const live = [observed(mx1), observed(mx2)];

    const [step] = computeDnsPlan([mx3], live);
    expect(step?.verdict).toBe("conflict");
    expect(step?.observed).toEqual(live);
  });

  it("merges into an existing SPF record, adding only the missing mechanisms", () => {
    const live = observed({ type: "TXT", name: "example.com", value: "v=spf1 include:othersender.example ~all" });
    const [step] = computeDnsPlan([spf], [live]);
    expect(step?.verdict).toBe("merge");
    expect(step?.merge?.mechanisms).toBe("include:amazonses.com");
  });

  it("finds the one SPF record among several TXT records at the name and merges into it", () => {
    const verification = observed({ type: "TXT", name: "example.com", value: "google-site-verification=abc" });
    const existingSpf = observed({ type: "TXT", name: "example.com", value: "v=spf1 include:othersender.example ~all" });
    const [step] = computeDnsPlan([spf], [verification, existingSpf]);
    expect(step?.verdict).toBe("merge");
  });

  it("treats an SPF record already carrying every needed mechanism as already correct", () => {
    const live = observed({ type: "TXT", name: "example.com", value: "v=spf1 include:amazonses.com include:othersender.example ~all" });
    const [step] = computeDnsPlan([spf], [live]);
    expect(step?.verdict).toBe("already_correct");
  });

  it("refuses to merge past the SPF lookup limit and reports it as a conflict, not a merge", () => {
    const nineIncludes = Array.from({ length: 9 }, (_, i) => `include:sender${i}.example`).join(" ");
    const live = observed({ type: "TXT", name: "example.com", value: `v=spf1 ${nineIncludes} ~all` });
    const wants: ProposedDnsRecord = { ...spf, value: "v=spf1 include:tenthsender.example include:eleventhsender.example ~all" };
    const [step] = computeDnsPlan([wants], [live]);
    expect(step?.verdict).toBe("conflict");
    expect(step?.merge).toBeUndefined();
    expect(step?.reason).toMatch(/lookup/i);
  });

  it("never suggests an overwrite in a conflict's reason", () => {
    const live = observed({ ...cname, value: "someone-else.example.net" });
    const [step] = computeDnsPlan([cname], [live]);
    expect(step?.reason.toLowerCase()).not.toContain("overwrite");
    expect(step?.reason.toLowerCase()).not.toContain("replace");
  });

  it("plans the rest of the domain's records when one is a conflict", () => {
    const conflicting = observed({ ...cname, value: "someone-else.example.net" });
    const okCname: ProposedDnsRecord = { type: "CNAME", name: "def._domainkey.example.com", value: "def.dkim.amazonses.com", required: true };
    const live: ObservedDnsRecord[] = [conflicting, observed(okCname)];
    const steps = computeDnsPlan([cname, okCname], live);
    expect(steps.map((step) => step.verdict)).toEqual(["conflict", "already_correct"]);
  });
});
