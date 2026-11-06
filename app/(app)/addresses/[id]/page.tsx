import { notFound } from "next/navigation";
import { ApiError } from "@/lib/api/errors";
import { listForwardTargetsFor } from "@/lib/addresses/forward-targets";
import { listAddressMessages } from "@/lib/addresses/inbox";
import { readAddress } from "@/lib/addresses/manage";
import { canWriteInOrganization } from "@/lib/auth/permissions";
import { requireOrganization, sessionActor } from "@/lib/dashboard/session";
import { readKey } from "@/lib/keys";
import { readOrganizationRecord } from "@/lib/organizations";
import { listAddressMessagesSchema } from "@/lib/schemas/address";
import { AddressDetail } from "./address-detail";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/** What the received-mail table shows. No body: the inbound detail reads that. */
const MESSAGE_FIELDS = "from,subject,verdicts,attachments,received_at";

function missing(error: unknown): boolean {
  return error instanceof ApiError && error.code === "not_found";
}

export default async function AddressPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ cursor?: string; forward_error?: string }> }) {
  const [{ id }, { cursor, forward_error: forwardError }] = await Promise.all([params, searchParams]);
  const session = await requireOrganization();
  const caller = { organizationId: session.organizationId, domainIds: [] as string[], apiKeyId: null };
  const actor = sessionActor(session);

  let address;
  try {
    address = await readAddress(caller, id);
  } catch (error) {
    if (missing(error)) notFound();
    throw error;
  }

  const query = listAddressMessagesSchema.parse({ limit: String(PAGE_SIZE), fields: MESSAGE_FIELDS, ...(cursor ? { cursor } : {}) });
  const [messages, targets, organization, key] = await Promise.all([
    listAddressMessages(caller, id, query).catch((error: unknown) => {
      if (missing(error)) notFound();
      throw error;
    }),
    listForwardTargetsFor(caller, id),
    readOrganizationRecord({ ...caller, actor }),
    address.key_id ? readKey({ ...caller, actor }, address.key_id).catch(() => null) : null,
  ]);

  return (
    <AddressDetail
      address={address}
      messages={messages.data}
      nextCursor={messages.next_cursor}
      paged={Boolean(cursor)}
      targets={targets.data}
      dailyLimit={organization.address_daily_message_limit}
      keyName={key?.name ?? null}
      canManage={canWriteInOrganization(session.role)}
      forwardError={forwardError ?? null}
    />
  );
}
