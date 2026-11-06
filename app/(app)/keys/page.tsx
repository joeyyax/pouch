import { requireOrganization } from "@/lib/dashboard/session";
import { canWriteInOrganization } from "@/lib/auth/permissions";
import { listDomainOptions } from "@/lib/dashboard/domain-options";
import { listKeys } from "@/lib/dashboard/keys";
import { readSetting } from "@/lib/settings/values";
import { KeysScreen } from "./keys-screen";

export const dynamic = "force-dynamic";

export default async function KeysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireOrganization();
  const { organizationId } = session;
  const { state } = await searchParams;
  const [keys, domainOptions, defaultRateLimit] = await Promise.all([
    listKeys(organizationId, session.timeZone),
    listDomainOptions(organizationId),
    readSetting("key_rate_limit_default"),
  ]);

  return (
    <KeysScreen
      keys={keys}
      domainOptions={domainOptions}
      defaultRateLimit={defaultRateLimit}
      creating={state === "create"}
      canManage={canWriteInOrganization(session.role)}
    />
  );
}
