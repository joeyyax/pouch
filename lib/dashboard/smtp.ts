import { smtpSnippets } from "@/lib/dashboard/curl";
import type { KeyDomainOption } from "@/lib/dashboard/views/keys";
import type { KeySmtp, SmtpEndpoint } from "@/lib/dashboard/views/smtp";

/** Where a key connects over SMTP, from the SMTP ingress's own variables. */
export function smtpEndpoint(): SmtpEndpoint {
  const production = process.env.NODE_ENV === "production";
  const host = process.env.SMTP_TLS_HOST?.trim() || (production ? null : "localhost");
  const port = Number(process.env.SMTP_SUBMISSION_PORT) || 587;
  // Same rule as createSubmissionServer: production never takes AUTH without TLS.
  const tls = production || process.env.SMTP_TLS_CERT_PATH ? "starttls" : "none";
  return { host, port, tls };
}

/** A key's SMTP details. `secret` is the key's own on creation, `KEY_PLACEHOLDER` after. */
export function keySmtp(key: { id: string; domainIds: string[] }, secret: string, options: KeyDomainOption[]): KeySmtp {
  const endpoint = smtpEndpoint();
  const everyDomain = key.domainIds.length === 0;
  const domains = everyDomain ? options : options.filter((option) => key.domainIds.includes(option.id));
  const from = (domains.find((option) => option.verified) ?? domains[0])?.name ?? "example.com";
  const { host } = endpoint;
  return {
    endpoint,
    domains,
    everyDomain,
    snippets: host ? smtpSnippets({ ...endpoint, host }, key.id, secret, `hi@${from}`) : null,
  };
}
