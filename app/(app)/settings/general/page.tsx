import { isOrgOwner } from "@/lib/auth/permissions";
import { listReachableOrganizations, requireOrganization } from "@/lib/dashboard/session";
import { DEFAULT_BODY_RETENTION_DAYS, listOwners, readOrganization, retentionCeiling } from "@/lib/organizations";
import { organizationDeleteBlock } from "@/lib/organizations/deletable";
import { organizationContents } from "@/lib/organizations/delete";
import { GeneralScreen } from "./general-screen";

export const dynamic = "force-dynamic";

export default async function SettingsGeneralPage() {
  const session = await requireOrganization();
  const [organization, owners, contents, own, ceiling] = await Promise.all([
    readOrganization(session.organizationId),
    listOwners(session.organizationId),
    organizationContents(session.organizationId),
    listReachableOrganizations(session.userId),
    retentionCeiling(),
  ]);

  // Read here so the button is disabled with the reason on it, not just refused on submit.
  const block = await organizationDeleteBlock({ id: session.organizationId, name: organization?.name ?? "" });

  return (
    <GeneralScreen
      organization={
        organization ?? {
          id: session.organizationId,
          name: "—",
          slug: "—",
          bodyRetentionDays: DEFAULT_BODY_RETENTION_DAYS,
        }
      }
      retentionCeiling={ceiling}
      owners={owners}
      contents={contents}
      deleteBlocked={block?.message ?? null}
      lastOrganization={own.length <= 1}
      canManage={isOrgOwner(session.role)}
    />
  );
}
