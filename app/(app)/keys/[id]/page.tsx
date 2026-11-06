import { notFound } from "next/navigation";
import { requireOrganization, sessionActor } from "@/lib/dashboard/session";
import { canWriteInOrganization } from "@/lib/auth/permissions";
import { listDomainOptions } from "@/lib/dashboard/domain-options";
import { readKey } from "@/lib/dashboard/keys";
import { listDeliveries, listEndpointViews } from "@/lib/dashboard/webhooks";
import { KeyDetail } from "../key-detail";

export const dynamic = "force-dynamic";

export default async function KeyPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireOrganization();
  const { organizationId } = session;
  const { id } = await params;

  const apiKey = await readKey(organizationId, id, session.timeZone);
  if (!apiKey) notFound();

  const caller = { organizationId, domainIds: [], actor: sessionActor(session) };
  const [endpoints, domainOptions] = await Promise.all([listEndpointViews(caller, id), listDomainOptions(organizationId)]);
  const deliveriesByEndpoint = Object.fromEntries(
    await Promise.all(endpoints.map(async (endpoint) => [endpoint.id, await listDeliveries(caller, endpoint.id)] as const)),
  );

  return (
    <KeyDetail
      apiKey={apiKey}
      endpoints={endpoints}
      deliveriesByEndpoint={deliveriesByEndpoint}
      domainOptions={domainOptions}
      canManage={canWriteInOrganization(session.role)}
    />
  );
}
