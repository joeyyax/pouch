import { db, type Executor } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { webhookDeliveries } from "@/lib/db/schema";
import type { InboundMessageRow, WebhookEndpointRow } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { DELIVERY_EXPIRY_MS } from "@/lib/webhooks/backoff";
import type { InboundBody } from "./attachments";
import { serializeInboundMessage } from "./serialize";

/**
 * Enqueues one `inbound.received` delivery to the domain's webhook endpoint. Goes through the
 * same webhook_deliveries table and WebhookLoop as every outbound event — signed, retried on
 * the same backoff schedule, logged the same way. Inside the transaction that stores the message,
 * so a failed enqueue rolls the message back for the provider to retry. The body rides inline;
 * the retention sweep nulls it here when the message goes.
 */
export async function enqueueInboundDelivery(
  endpoint: WebhookEndpointRow,
  message: InboundMessageRow,
  body: InboundBody,
  executor: Executor = db,
): Promise<void> {
  const now = await dbNow(executor);
  await executor.insert(webhookDeliveries).values({
    id: newId("webhookDelivery"),
    organizationId: message.organizationId,
    endpointId: endpoint.id,
    // Not an outbound message: the delivery isn't recorded on a message's own timeline.
    messageId: null,
    eventType: "inbound.received",
    payload: {
      id: newId("event"),
      type: "inbound.received",
      created_at: message.receivedAt.toISOString(),
      data: serializeInboundMessage(message, body),
    },
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    expiresAt: new Date(now.getTime() + DELIVERY_EXPIRY_MS),
  });
}
