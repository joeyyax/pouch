/**
 * Whether a domain may send bulk (#246). Two independent gates: the operator has to have
 * turned it on for this domain, and the domain's provider adapter has to be able to do it at
 * all. The provider fact is checked first — it's never a policy choice, so it wins over an
 * operator's own setting either way.
 */
import { ApiError } from "@/lib/api/errors";
import { capabilitiesOf } from "@/lib/providers/adapters";

export type BulkNotAllowedReason = "provider_incapable" | "domain_disabled";

export interface BulkGateDomain {
  bulkAllowed: boolean;
}

/** Which fact blocks bulk for this domain, or null when both gates are open. */
export function bulkNotAllowedReason(domain: BulkGateDomain, providerAdapter: string): BulkNotAllowedReason | null {
  if (!capabilitiesOf(providerAdapter).bulk) return "provider_incapable";
  if (!domain.bulkAllowed) return "domain_disabled";
  return null;
}

/** The two reasons send an operator to different places: move the domain, or flip a switch. */
export function bulkNotAllowedMessage(reason: BulkNotAllowedReason, domainName: string): string {
  return reason === "provider_incapable"
    ? `${domainName}'s provider doesn't support bulk sends.`
    : `Bulk sending is turned off for ${domainName}. Turn it on in domain settings to send batches.`;
}

/** Throws `bulk_not_allowed` naming which reason applied, or returns when both gates are open. */
export function assertBulkAllowed(domain: BulkGateDomain, providerAdapter: string, domainName: string): void {
  const reason = bulkNotAllowedReason(domain, providerAdapter);
  if (!reason) return;
  throw new ApiError("bulk_not_allowed", bulkNotAllowedMessage(reason, domainName), { detail: { reason } });
}
