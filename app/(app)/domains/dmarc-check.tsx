import { checkDmarc } from "@/lib/domains/dmarc";
import { dmarcReportUri } from "@/lib/dmarc/host";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { DmarcCard } from "./dmarc-card";

/** Reads the domain's DMARC record on the server. Rendered in a `<Suspense>` boundary, so the record list never waits on it. */
export async function DmarcCheck({ domain, records }: { domain: { id: string; organizationId: string; name: string }; records: ProposedDnsRecord[] }) {
  const reportUri = await dmarcReportUri(domain);
  return <DmarcCard domainName={domain.name} dmarc={await checkDmarc(domain.name, records, reportUri)} />;
}

export function DmarcCheckFallback() {
  return <p className="type-body-sm text-muted-foreground">Reading DMARC…</p>;
}
