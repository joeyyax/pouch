import type { DomainStatus } from "@/lib/db/schema";
import type { ProposedDnsRecord, VerificationStatus } from "@/lib/providers/adapters/types";

/**
 * Whether the provider actually answered. A timeout, an expired credential or an inconclusive
 * answer must never read as "this domain isn't verified", so each adapter states the fact itself.
 */
export function providerAnswered(status: VerificationStatus): boolean {
  return status.answered;
}

export interface DomainVerificationState {
  status: DomainStatus;
  verifiedAt: Date | null;
  verificationErrors: string[];
  /** What the check couldn't see, so the dashboard can mark each record without asking again. */
  missingRecords: ProposedDnsRecord[];
}

/**
 * What a domain's stored status, `verified_at` and reasons should become for an answered check.
 * Call only when `providerAnswered` is true. A reason attached to an unverified answer, such as
 * a failed DKIM check, fails the domain and keeps it; a verified answer clears it; an unverified
 * answer with no reason just isn't there yet.
 */
export function nextVerificationState(
  status: VerificationStatus,
  current: { verifiedAt: Date | null },
  now: Date,
): DomainVerificationState {
  if (status.verified) {
    return { status: "verified", verifiedAt: current.verifiedAt ?? now, verificationErrors: [], missingRecords: [] };
  }
  if (status.errors.length > 0) {
    return { status: "failed", verifiedAt: null, verificationErrors: status.errors, missingRecords: status.missing };
  }
  return { status: "pending", verifiedAt: null, verificationErrors: [], missingRecords: status.missing };
}
