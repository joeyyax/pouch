import { blocklistStatus, type BlocklistStatus } from "@/lib/blocklists/status";
import { isOrgOwner } from "@/lib/auth/permissions";
import { requireOrganization } from "@/lib/dashboard/session";
import { queueSummary } from "@/lib/dashboard/messages";
import { readSendingProvider } from "@/lib/dashboard/service";
import { dbNow } from "@/lib/db/clock";
import { isFeatureEnabled } from "@/lib/features";
import { listObservationSettings } from "@/lib/observations/_mutes";
import { activeReportHost } from "@/lib/dmarc/host";
import { dmarcOnFor } from "@/lib/dmarc/switch";
import { SendingScreen } from "./sending-screen";

export const dynamic = "force-dynamic";

export default async function SettingsSendingPage() {
  const session = await requireOrganization();
  const [sending, queue, blocklists, observations, reportHost, dmarcEnabled, dmarcFeature] = await Promise.all([
    readSendingProvider(session.organizationId),
    queueSummary(session.organizationId),
    dbNow().then(blocklistStatus).catch((): BlocklistStatus => ({ state: "no_redis" })),
    isFeatureEnabled("observations").then((on) => (on ? listObservationSettings(session.organizationId) : null)),
    activeReportHost(),
    dmarcOnFor(session.organizationId),
    isFeatureEnabled("dmarc_reports"),
  ]);

  return (
    <SendingScreen
      provider={sending}
      manageHref={session.admin && sending ? `/admin/settings/providers/${sending.adminProviderId}` : null}
      queue={queue}
      blocklists={blocklists}
      zone={session.timeZone}
      observations={dmarcEnabled || !observations ? observations : observations.filter((observation) => observation.key !== "domain_spoofed")}
      dmarcReports={dmarcFeature ? { available: reportHost !== null, enabled: dmarcEnabled } : null}
      canManage={isOrgOwner(session.role)}
    />
  );
}
