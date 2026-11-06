"use client";

import type { ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import type { DomainDetailData, ProviderOption } from "@/lib/dashboard/views/domains";
import { SectionHeader } from "../_ui/section-header";
import { DnsRecords } from "./dns-records";
import { ProviderCard } from "./provider-card";

/** DNS records and their live check, DMARC, the reconciliation plan and cleanup, and the provider. */
export function SetupSection({
  domain,
  providers,
  canManage,
  liveRecords,
  livePendingRecords,
  dmarc,
  dnsPlan,
  dnsCleanup,
  pendingDnsPlan,
  previousProviderCleanup,
}: {
  domain: DomainDetailData;
  providers: ProviderOption[];
  canManage: boolean;
  /** A live-check element per record in `domain.dnsRecords`, keyed by `recordKey`. */
  liveRecords: Record<string, ReactNode>;
  /** Same, for `domain.pending.dnsRecords` when a move is in progress. */
  livePendingRecords: Record<string, ReactNode>;
  /** The DMARC record's state, read server-side. */
  dmarc: ReactNode;
  /** The reconciliation plan against the live zone, resolved server-side. */
  dnsPlan: ReactNode;
  /** What's safe to remove from provenance, resolved server-side. */
  dnsCleanup: ReactNode;
  /** The reconciliation plan for a pending move's required records. Null without a move. */
  pendingDnsPlan: ReactNode;
  /** What's safe to remove from the previous provider's provenance, resolved server-side. */
  previousProviderCleanup: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      {domain.status === "failed" && domain.verificationErrors.length > 0 ? (
        <Alert tone="danger" title="Verification failed">
          <ul className="flex flex-col gap-1">
            {domain.verificationErrors.map((reason) => (
              <li key={reason} className="font-mono text-sm">
                {reason}
              </li>
            ))}
          </ul>
          <span className="mt-2 block">Add the missing records and verify again.</span>
        </Alert>
      ) : null}

      <Card className="p-5">
        <DnsRecords
          records={domain.dnsRecords}
          missing={domain.missingRecords}
          checked={domain.lastCheckedAt !== null}
          liveSlots={liveRecords}
          description={
            domain.status === "pending" && domain.dnsRecords.length > 0
              ? "Add these records at your DNS host, then verify."
              : undefined
          }
        />
      </Card>

      <Card className="p-5">{dmarc}</Card>

      <Card className="flex flex-col gap-3 p-5">
        <SectionHeader
          title="Reconciliation plan"
          meta="What each record needs in the live zone. A conflict is never published automatically."
        />
        {dnsPlan}
        {dnsCleanup}
      </Card>

      <ProviderCard
        domainId={domain.id}
        domainName={domain.name}
        current={{ id: domain.provider.id, name: domain.provider.name, adapterLabel: domain.provider.adapterLabel }}
        pending={domain.pending}
        providers={providers}
        canManage={canManage}
        liveRecords={livePendingRecords}
        pendingDnsPlan={pendingDnsPlan}
        previousProviderCleanup={previousProviderCleanup}
      />

      {domain.setup.length > 0 ? (
        <Card className="flex flex-col gap-3 p-5">
          <SectionHeader title="Setup outside the app" meta={domain.provider.adapterLabel} />
          <ol className="flex flex-col gap-2">
            {domain.setup.map((step, index) => (
              <li key={step.step} className="flex items-start gap-3">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-2xs font-semibold text-muted-foreground">
                  {index + 1}
                </span>
                <span className="type-body-sm min-w-0 flex-1 text-foreground-soft">{step.message}</span>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}
    </div>
  );
}
