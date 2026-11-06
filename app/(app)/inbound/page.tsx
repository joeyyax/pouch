import { requireOrganization } from "@/lib/dashboard/session";
import { inboundByDay, latestInboundDeliveries, listInboundFilterDomains, listInboundForOrg } from "@/lib/dashboard/inbound";
import { InboundScreen } from "./inbound-screen";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function InboundPage({
  searchParams,
}: {
  searchParams: Promise<{ domain?: string; cursor?: string }>;
}) {
  const { organizationId, timeZone } = await requireOrganization();
  const params = await searchParams;
  const [page, domainOptions, daily] = await Promise.all([
    listInboundForOrg(organizationId, PAGE_SIZE, params.cursor, params.domain),
    listInboundFilterDomains(organizationId),
    inboundByDay(organizationId, timeZone, { domainId: params.domain }),
  ]);
  const deliveries = await latestInboundDeliveries(
    organizationId,
    page.data.map((message) => ({ id: message.id, receivedAt: new Date(message.received_at) })),
  );

  return (
    <InboundScreen
      messages={page.data}
      nextCursor={page.next_cursor}
      paged={Boolean(params.cursor)}
      domains={domainOptions}
      domainId={params.domain ?? null}
      daily={daily}
      deliveries={deliveries}
    />
  );
}
