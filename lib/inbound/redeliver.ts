import { readDomainEndpoint } from "@/lib/webhooks/endpoints";
import { readInboundBody } from "./attachments";
import { enqueueInboundDelivery } from "./deliver";
import { readInboundMessage } from "./list";

/**
 * Re-enqueues the domain's webhook with the payload the original delivery carried. False when
 * the message is gone or the domain has no webhook endpoint.
 */
export async function redeliverInbound(organizationId: string, id: string): Promise<boolean> {
  const message = await readInboundMessage(organizationId, id);
  if (!message) return false;
  const endpoint = await readDomainEndpoint(organizationId, message.domainId);
  if (!endpoint) return false;

  await enqueueInboundDelivery(endpoint, message, await readInboundBody(message));
  return true;
}
