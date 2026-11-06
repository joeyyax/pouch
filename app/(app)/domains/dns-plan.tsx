import { planDomainDns } from "@/lib/domains/dns-plan";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { DnsPlanCardView } from "./dns-plan-view";
import { applyPendingDnsPlanAction } from "./actions";

/**
 * Fetches and renders the reconciliation plan for one domain. A server component so the live
 * zone read runs server-side against the provider's own API — see `planDomainDns` for why that's
 * a different read than #190's public-resolver check. Rendered inside a `<Suspense>` boundary by
 * its caller, so the record list beside it never waits on this.
 */
export async function DnsPlan({
  organizationId,
  domainId,
  domainName,
  requiredRecords,
  canManage,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  requiredRecords: ProposedDnsRecord[];
  canManage: boolean;
}) {
  const plan = await planDomainDns(organizationId, { name: domainName, dnsRecords: requiredRecords });
  return <DnsPlanCardView plan={plan} domainId={domainId} canManage={canManage} />;
}

export function DnsPlanFallback() {
  return <p className="type-body-sm text-muted-foreground">Reading the live zone…</p>;
}

/**
 * Same reconciliation plan, for a pending provider move's required records (#212). The
 * zone read is identical — a domain has one live zone regardless of which account is asking for
 * records in it — only `requiredRecords` and the apply action differ, so this publishes the
 * *pending* binding's records, coexisting with whatever the current account still has published.
 */
export async function PendingDnsPlan({
  organizationId,
  domainId,
  domainName,
  requiredRecords,
  canManage,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  requiredRecords: ProposedDnsRecord[];
  canManage: boolean;
}) {
  const plan = await planDomainDns(organizationId, { name: domainName, dnsRecords: requiredRecords });
  return <DnsPlanCardView plan={plan} domainId={domainId} canManage={canManage} applyAction={applyPendingDnsPlanAction} />;
}
