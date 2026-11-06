import { readDmarcReportHost } from "@/lib/dashboard/admin-general";
import { isFeatureEnabled } from "@/lib/features";
import { DmarcReportsCard } from "../general/dmarc-reports-card";
import { RegistryPage } from "../_registry/registry-page";

export const dynamic = "force-dynamic";

export default async function AdminReputationPage() {
  const dmarcReports = (await isFeatureEnabled("dmarc_reports")) ? await readDmarcReportHost() : null;
  return <RegistryPage page="reputation">{dmarcReports ? <DmarcReportsCard view={dmarcReports} /> : null}</RegistryPage>;
}
