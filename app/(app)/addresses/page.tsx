import { listAddresses } from "@/lib/addresses/manage";
import { ADDRESS_STATUSES, type AddressStatus } from "@/lib/addresses/constants";
import { canWriteInOrganization } from "@/lib/auth/permissions";
import { loadAddressCreateOptions } from "@/lib/dashboard/addresses";
import { requireOrganization, sessionActor } from "@/lib/dashboard/session";
import { readOrganizationRecord } from "@/lib/organizations";
import { AddressesScreen } from "./addresses-screen";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

function parseStatus(value: string | undefined): AddressStatus | undefined {
  return ADDRESS_STATUSES.find((status) => status === value);
}

export default async function AddressesPage({ searchParams }: { searchParams: Promise<{ cursor?: string; status?: string }> }) {
  const { cursor, status: rawStatus } = await searchParams;
  const status = parseStatus(rawStatus);
  const session = await requireOrganization();
  const caller = { organizationId: session.organizationId, domainIds: [] as string[], apiKeyId: null };

  const [page, organization, create] = await Promise.all([
    listAddresses(caller, PAGE_SIZE, cursor, { status }),
    readOrganizationRecord({ ...caller, actor: sessionActor(session) }, { addressCounts: true }),
    loadAddressCreateOptions(session.organizationId),
  ]);

  return (
    <AddressesScreen
      addresses={page.data}
      counts={organization.address_counts ?? { active: 0, expired: 0, revoked: 0 }}
      limits={{ active: organization.address_limit, daily: organization.address_daily_message_limit }}
      status={status ?? null}
      nextCursor={page.next_cursor}
      paged={Boolean(cursor)}
      canManage={canWriteInOrganization(session.role)}
      create={create}
    />
  );
}
