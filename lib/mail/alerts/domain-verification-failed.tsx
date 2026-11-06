import type { DomainRow } from "@/lib/domains";
import { sendSystemAlert } from "@/lib/mail/system";
import { SystemMail, type SystemMailBody } from "@/lib/mail/template";
import { organizationName } from "./names";

/**
 * One state change, one alert: keyed on the domain and the verified period that just ended.
 * `verifiedAt` only changes when the domain verifies again, so a worker that reprocesses the
 * same check — or restarts mid-run before writing the new status — replays the same message
 * instead of sending a second one.
 */
function idempotencyKey(domain: DomainRow): string {
  const verifiedAt = domain.verifiedAt?.toISOString() ?? "unknown";
  return `domain-verification-failed:${domain.id}:${verifiedAt}`;
}

/** The alert's body; the footer is added per recipient. */
export function domainVerificationFailedMail(domain: DomainRow, errors: string[], organization: string): Omit<SystemMailBody, "reason"> {
  return {
    heading: `${domain.name} isn't verified anymore`,
    paragraphs: [
      errors.length > 0 ? `The provider reports: ${errors.join("; ")}.` : "The provider no longer confirms its DNS records.",
      "Check the domain's DNS records, then verify it again from the dashboard.",
    ],
    facts: [
      ["Domain", domain.name],
      ["Organization", organization],
    ],
  };
}

export function DomainVerificationFailedEmail({ domain, errors, organization, reason }: { domain: DomainRow; errors: string[]; organization: string; reason: string }) {
  return <SystemMail {...domainVerificationFailedMail(domain, errors, organization)} reason={reason} />;
}

/** Sends the alert for a domain that was verified and just failed. `domain` is the row as read before the failing check. */
export async function sendDomainVerificationFailedAlert(domain: DomainRow, errors: string[]): Promise<void> {
  const organization = await organizationName(domain.organizationId);
  await sendSystemAlert({
    subject: `Domain verification failed: ${domain.name}`,
    email: (reason) => <DomainVerificationFailedEmail domain={domain} errors={errors} organization={organization} reason={reason} />,
    idempotencyKey: idempotencyKey(domain),
  });
}
