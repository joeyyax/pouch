/** Who sent a report row's mail, read from the domain's own DNS records rather than provider IP ranges. */
import type { DmarcOrigin } from "@/lib/db/schema";
import { aligns } from "@/lib/domains/dmarc";
import { isSpfValue } from "@/lib/domains/spf";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import type { ReportRecord } from "./parse";

const DKIM_LABEL = "._domainkey.";

/** How the domain's provider authenticates its mail: the DKIM keys it signs with and the envelope hosts it bounces through. */
export interface ProviderIdentity {
  dkim: { selector: string; domain: string }[];
  envelopeHosts: string[];
}

/**
 * The DKIM selectors under `._domainkey.`, and the hosts other than the domain itself that hold
 * an SPF record or a return-path CNAME. The apex's SPF is shared with every other sender the
 * domain authorizes, so it never identifies the provider.
 */
export function providerIdentity(domain: string, records: ProposedDnsRecord[], inboundHost: string | null): ProviderIdentity {
  const apex = domain.toLowerCase();
  const dkim: ProviderIdentity["dkim"] = [];
  const envelopeHosts = new Set<string>();
  for (const record of records) {
    const name = record.name.toLowerCase().replace(/\.$/, "");
    const at = name.indexOf(DKIM_LABEL);
    if (at >= 0) {
      dkim.push({ selector: name.slice(0, at), domain: name.slice(at + DKIM_LABEL.length) });
      continue;
    }
    if (name === apex || name === inboundHost?.toLowerCase()) continue;
    if ((record.type === "TXT" && isSpfValue(record.value)) || record.type === "CNAME") envelopeHosts.add(name);
  }
  return { dkim, envelopeHosts: [...envelopeHosts] };
}

/**
 * - `provider`: carries the provider's DKIM key or envelope host and passed SPF or that DKIM, so it
 *   left the provider directly.
 * - `forwarded`: a DKIM signature aligned with the domain is there but nothing passed, the mark of
 *   mail a forwarder or list relayed and changed.
 * - `other`: passes DMARC without the provider, so a sender the domain itself authorizes.
 * - `unauthenticated`: none of those. Someone else sending as the domain.
 */
export function classifyRecord(domain: string, record: ReportRecord, identity: ProviderIdentity): DmarcOrigin {
  const ownKey = record.dkimResults.filter((result) =>
    identity.dkim.some((key) => key.domain === result.domain && (result.selector === null || key.selector === result.selector)),
  );
  const ownEnvelope = record.spfResults.filter((result) => identity.envelopeHosts.includes(result.domain));
  if (ownKey.length > 0 || ownEnvelope.length > 0) {
    const passed =
      ownKey.some((result) => result.result === "pass") ||
      ownEnvelope.some((result) => result.result === "pass") ||
      record.spfResults.some((result) => result.result === "pass");
    return passed ? "provider" : "forwarded";
  }
  if (record.dkim === "pass" || record.spf === "pass") return "other";
  if (record.dkimResults.some((result) => aligns(result.domain, domain, "relaxed"))) return "forwarded";
  return "unauthenticated";
}
