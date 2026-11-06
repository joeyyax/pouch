import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireOrganization, sessionActor } from "@/lib/dashboard/session";
import { canWriteInOrganization } from "@/lib/auth/permissions";
import {
  latestInProgressTestMessage,
  listProviderOptions,
  readDomain,
  readDomainKeys,
  readDomainStanding,
  readDomainSuppressions,
} from "@/lib/dashboard/domains";
import { KEY_PLACEHOLDER, sendSnippets } from "@/lib/dashboard/curl";
import { readDomainReputationDetail } from "@/lib/domains";
import { isFeatureEnabled } from "@/lib/features";
import { dbNow } from "@/lib/db/clock";
import { readDmarcPanel } from "@/lib/dmarc/read";
import { dnsLiveSlots } from "../dns-live-slots";
import { DmarcCheck, DmarcCheckFallback } from "../dmarc-check";
import { DnsCleanup, DnsCleanupFallback, PreviousAccountCleanup } from "../dns-cleanup";
import { DnsPlan, DnsPlanFallback, PendingDnsPlan } from "../dns-plan";
import { DomainDetail } from "../domain-detail";
import { defaultSection, type DomainSection } from "../sections";
import { SendingSection } from "../sending-section";
import { SetupSection } from "../setup-section";
import { ReputationSection } from "./reputation/reputation-screen";

/** One domain, one section. Null picks the section from the domain's state. */
export async function DomainPage({ params, section }: { params: Promise<{ id: string }>; section: DomainSection | null }) {
  const session = await requireOrganization();
  const { id } = await params;
  const organizationId = session.organizationId;
  const caller = { organizationId, domainIds: [] as string[], actor: sessionActor(session) };

  const domain = await readDomain(caller, id);
  if (!domain) notFound();

  const standing = domain.status === "verified" || domain.stall ? await readDomainStanding(organizationId, id) : null;
  const active = section ?? defaultSection(domain.status, standing?.standing ?? null);
  const canManage = canWriteInOrganization(session.role);

  let body;
  if (active === "setup") {
    const providerOptions = await listProviderOptions(organizationId);
    // Each live check, plan and cleanup reads DNS or the provider on its own, so each gets its
    // own Suspense boundary and the record list paints first.
    body = (
      <SetupSection
        domain={domain}
        providers={providerOptions}
        canManage={canManage}
        liveRecords={dnsLiveSlots(domain.dnsRecords, domain.missingRecords)}
        livePendingRecords={dnsLiveSlots(domain.pending?.dnsRecords ?? [], domain.pending?.missingRecords ?? [])}
        dmarc={
          <Suspense key="dmarc" fallback={<DmarcCheckFallback />}>
            <DmarcCheck domain={{ id: domain.id, organizationId, name: domain.name }} records={domain.dnsRecords} />
          </Suspense>
        }
        dnsPlan={
          <Suspense key="plan" fallback={<DnsPlanFallback />}>
            <DnsPlan
              organizationId={organizationId}
              domainId={domain.id}
              domainName={domain.name}
              requiredRecords={domain.dnsRecords}
              canManage={canManage}
            />
          </Suspense>
        }
        dnsCleanup={
          <Suspense key="cleanup" fallback={<DnsCleanupFallback />}>
            <DnsCleanup caller={caller} domainId={domain.id} domainName={domain.name} canManage={canManage} />
          </Suspense>
        }
        pendingDnsPlan={
          domain.pending ? (
            <Suspense key="pending-plan" fallback={<DnsPlanFallback />}>
              <PendingDnsPlan
                organizationId={organizationId}
                domainId={domain.id}
                domainName={domain.name}
                requiredRecords={domain.pending.dnsRecords}
                canManage={canManage}
              />
            </Suspense>
          ) : null
        }
        previousProviderCleanup={
          <Suspense key="previous-cleanup" fallback={null}>
            <PreviousAccountCleanup caller={caller} domainId={domain.id} domainName={domain.name} canManage={canManage} />
          </Suspense>
        }
      />
    );
  } else if (active === "sending") {
    const [inProgressTest, keys, bulk] = await Promise.all([
      latestInProgressTestMessage(organizationId, id),
      readDomainKeys(caller, id),
      isFeatureEnabled("bulk"),
    ]);
    body = (
      <SendingSection
        domain={domain}
        keys={keys}
        defaultTo={session.email}
        inProgressTest={inProgressTest}
        sendSnippets={domain.status === "verified" ? sendSnippets(KEY_PLACEHOLDER, domain.name) : null}
        bulk={bulk}
        canManage={canManage}
      />
    );
  } else {
    const [reputation, suppressions, dmarcReports] = await Promise.all([
      readDomainReputationDetail(caller, id),
      readDomainSuppressions(caller, id),
      dbNow().then((now) => readDmarcPanel(organizationId, { id, name: domain.name }, now)),
    ]);
    body = (
      <ReputationSection domain={domain} reputation={reputation} suppressions={suppressions} dmarcReports={dmarcReports} zone={session.timeZone} />
    );
  }

  return (
    <DomainDetail domain={domain} standing={standing} canManage={canManage} section={active}>
      {body}
    </DomainDetail>
  );
}
