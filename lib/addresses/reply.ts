import { and, arrayContains, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, inboundMessages, providers, type InboundMessageRow } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { assertLiveKey, type OrganizationKeyRow } from "@/lib/api/keys";
import { parseAddress } from "@/lib/addresses";
import { header, replyHeaders } from "@/lib/inbound/threading";
import { inboundHost } from "@/lib/inbound/records";
import { acceptMessage, type AcceptedMessage } from "@/lib/messages/create";
import { capabilitiesOf } from "@/lib/providers/adapters";
import type { ReplyFromAddressRequest } from "@/lib/schemas/address";
import { requiresStrictDkim } from "./alignment";
import { addressInScope } from "./manage";
import { statusAt } from "./serialize";
import { brand } from "@/lib/brand";

/** Where a reply goes: the first `Reply-To` address, else the sender. */
export function replyTarget(message: Pick<InboundMessageRow, "headers" | "fromAddress">): string {
  const replyTo = header(message.headers, "reply-to");
  const first = replyTo ? parseAddress(replyTo.split(",")[0] ?? "") : null;
  return first?.address ?? message.fromAddress;
}

/** "Re: " and the original subject, kept to one line and the header limit. */
function replySubject(subject: string): string {
  const flat = subject.replace(/[\x00-\x1F\x7F\u0085\u2028\u2029]+/g, " ").trim();
  const prefixed = /^re:/i.test(flat) ? flat : `Re: ${flat}`.trim();
  return prefixed.slice(0, 998);
}

function refused(reason: "sender_unverified" | "provider_incapable" | "strict_alignment", message: string): ApiError {
  return new ApiError("reply_not_allowed", message, { detail: { reason } });
}

/**
 * Sends a reply from an address to a message it received, through the ordinary send path, with
 * `In-Reply-To` and `References` set from that message.
 */
export async function replyFromAddress(
  key: OrganizationKeyRow,
  addressId: string,
  input: ReplyFromAddressRequest,
  idempotencyKey: string | null,
): Promise<AcceptedMessage> {
  assertLiveKey(key, "send from an address");
  const caller = { organizationId: key.organizationId, domainIds: key.domainIds, apiKeyId: key.id };
  const { row: address } = await addressInScope(db, caller, addressId);

  const status = statusAt(address, await dbNow());
  if (status !== "active") {
    throw new ApiError("address_inactive", `This address is ${status} and can't send.`, { detail: { status } });
  }

  const [message] = await db
    .select()
    .from(inboundMessages)
    .where(
      and(
        eq(inboundMessages.organizationId, key.organizationId),
        eq(inboundMessages.id, input.message_id),
        arrayContains(inboundMessages.addressIds, [address.id]),
      ),
    )
    .limit(1);
  if (!message) throw new ApiError("not_found", `No message with id ${input.message_id} on this address.`, { field: "message_id" });
  if (message.verdicts?.dmarc === "fail") {
    throw refused("sender_unverified", `This message failed DMARC, so its sender may be forged. ${brand.name} won't reply to it.`);
  }

  const [domain] = await db
    .select({ name: domains.name, inboundSubdomain: domains.inboundSubdomain, adapter: providers.adapter })
    .from(domains)
    .innerJoin(providers, eq(providers.id, domains.providerId))
    .where(eq(domains.id, address.domainId))
    .limit(1);
  if (!domain) throw new ApiError("not_found", `No address with id ${addressId}.`);

  const host = inboundHost(domain.name, domain.inboundSubdomain);
  if (!capabilitiesOf(domain.adapter).subdomainSending) {
    throw refused("provider_incapable", `This domain's provider can't send from ${host}, so the address can't reply.`);
  }
  if (await requiresStrictDkim(host)) {
    throw refused(
      "strict_alignment",
      `The DMARC policy for ${host} sets adkim=s, which a reply signed for ${domain.name} fails. Relax it to adkim=r to reply.`,
    );
  }

  return acceptMessage(
    key,
    {
      from: `${address.localPart}@${host}`,
      to: [replyTarget(message)],
      cc: input.cc,
      subject: input.subject ?? replySubject(message.subject),
      html: input.html,
      text: input.text,
      attachments: input.attachments,
      tags: input.tags,
      headers: replyHeaders(message),
    },
    idempotencyKey,
    { fromDomainId: address.domainId },
  );
}
