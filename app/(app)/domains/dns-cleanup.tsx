import { planDnsCleanup } from "@/lib/domains/dns-cleanup";
import { brand } from "@/lib/brand";
import type { DomainCaller } from "@/lib/domains";
import { DnsCleanupCardView } from "./dns-cleanup-view";
import { removePreviousAccountCleanupAction } from "./actions";

/**
 * Fetches and renders what's safe to remove from the live zone for one domain — every row
 * `dns_provider_records` still holds, re-checked against a fresh, authoritative read. A server
 * component for the same reason `DnsPlan` is: the live-zone read runs server-side, and this is
 * rendered inside its own `<Suspense>` boundary so the rest of the page never waits on it.
 */
export async function DnsCleanup({
  caller,
  domainId,
  domainName,
  canManage,
}: {
  caller: DomainCaller;
  domainId: string;
  domainName: string;
  canManage: boolean;
}) {
  const plan = await planDnsCleanup(caller, domainId);
  if (plan.steps.length === 0 && plan.status === "ready") return null;
  return <DnsCleanupCardView plan={plan} domainId={domainId} domainName={domainName} canManage={canManage} />;
}

export function DnsCleanupFallback() {
  return null;
}

/**
 * The post-cutover cleanup action (#212): what's safe to remove from the *previous* account
 * once a provider move has cut over, scoped to only that account's provenance —
 * `planDnsCleanup(..., "previous_account")` never includes a row that's still part of what the
 * domain requires today, so the new account's records are never a candidate here. Renders
 * nothing while a move is still pending, since nothing is stale relative to `dnsRecords` yet.
 * Dismissible and explicit, same as #211's cleanup action — cutover itself never calls this.
 */
export async function PreviousAccountCleanup({
  caller,
  domainId,
  domainName,
  canManage,
}: {
  caller: DomainCaller;
  domainId: string;
  domainName: string;
  canManage: boolean;
}) {
  const plan = await planDnsCleanup(caller, domainId, "previous_account");
  if (plan.steps.length === 0 && plan.status === "ready") return null;
  return (
    <DnsCleanupCardView
      plan={plan}
      domainId={domainId}
      domainName={domainName}
      canManage={canManage}
      title="Clean up records from the previous account"
      description={`Records the previous account needed and this one doesn't. A record changed since ${brand.name} wrote it is left alone.`}
      removeAction={removePreviousAccountCleanupAction}
    />
  );
}
