import { describe, expect, it } from "vitest";
import { nextVerificationState, providerAnswered } from "@/lib/domains/verification";
import type { ProposedDnsRecord, VerificationStatus } from "@/lib/providers/adapters/types";

const now = new Date("2026-09-08T14:36:00Z");

const missing: ProposedDnsRecord[] = [
  { type: "CNAME", name: "mp2._domainkey.example.com", value: "mp2.dkim.mailpace.com", required: true },
  { type: "TXT", name: "_dmarc.example.com", value: "v=DMARC1; p=none", required: false },
];

function status(overrides: Partial<VerificationStatus> = {}): VerificationStatus {
  return { answered: true, verified: false, missing: [], errors: [], ...overrides };
}

describe("nextVerificationState", () => {
  it("keeps what a pending check couldn't see, so the dashboard needn't ask again", () => {
    const next = nextVerificationState(status({ missing }), { verifiedAt: null }, now);
    expect(next.status).toBe("pending");
    expect(next.missingRecords).toEqual(missing);
  });

  it("keeps them on a failed check too, alongside the provider's reasons", () => {
    const next = nextVerificationState(status({ missing, errors: ["DKIM record not found"] }), { verifiedAt: null }, now);
    expect(next.status).toBe("failed");
    expect(next.verificationErrors).toEqual(["DKIM record not found"]);
    expect(next.missingRecords).toEqual(missing);
  });

  it("clears them once the domain verifies", () => {
    const next = nextVerificationState(status({ verified: true, missing }), { verifiedAt: null }, now);
    expect(next.status).toBe("verified");
    expect(next.missingRecords).toEqual([]);
    expect(next.verifiedAt).toEqual(now);
  });

  it("keeps the first verified_at rather than moving it on every check", () => {
    const first = new Date("2026-06-14T11:04:00Z");
    expect(nextVerificationState(status({ verified: true }), { verifiedAt: first }, now).verifiedAt).toEqual(first);
  });

  it("leaves an unanswered check to the caller", () => {
    expect(providerAnswered(status({ answered: false }))).toBe(false);
  });
});
