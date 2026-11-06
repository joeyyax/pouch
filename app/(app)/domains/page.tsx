import { requireOrganization } from "@/lib/dashboard/session";
import { canWriteInOrganization } from "@/lib/auth/permissions";
import { listDomains, listProviderOptions } from "@/lib/dashboard/domains";
import { DomainsScreen } from "./domains-screen";

export const dynamic = "force-dynamic";

export default async function DomainsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireOrganization();
  const { organizationId } = session;
  const { state } = await searchParams;
  const [rows, providers] = await Promise.all([
    listDomains(organizationId, session.timeZone),
    listProviderOptions(organizationId),
  ]);

  return <DomainsScreen rows={rows} providers={providers} adding={state === "add"} canManage={canWriteInOrganization(session.role)} />;
}
