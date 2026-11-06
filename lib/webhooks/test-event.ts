import { db } from "@/lib/db";
import { brand } from "@/lib/brand";
import { dbNow } from "@/lib/db/clock";
import { webhookDeliveries, type WebhookEndpointRow } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { DELIVERY_EXPIRY_MS } from "./backoff";

/** A synthetic message a "send a test event" delivers, shaped like lib/messages/serialize.ts's output. */
function syntheticMessageData() {
  const now = new Date().toISOString();
  return {
    id: "msg_test0000000000000000",
    url: "https://example.com/v1/emails/msg_test0000000000000000",
    status: "delivered",
    from: `${brand.fromName} <notifications@example.com>`,
    to: ["person@example.net"],
    cc: [],
    bcc: [],
    reply_to: [],
    subject: "This is a test event",
    tags: [],
    test_mode: true,
    provider_message_id: "test-event",
    reason: null,
    attempts: 1,
    created_at: now,
    sent_at: now,
    delivered_at: now,
  };
}

/**
 * Delivers a synthetic `email.delivered` through the real path: it's a normal webhook_deliveries
 * row, so the worker's WebhookLoop signs and posts it exactly like a real event.
 */
export async function sendTestEvent(endpoint: WebhookEndpointRow): Promise<string> {
  const id = newId("webhookDelivery");
  const now = await dbNow();
  await db.insert(webhookDeliveries).values({
    id,
    organizationId: endpoint.organizationId,
    endpointId: endpoint.id,
    messageId: null,
    eventType: "email.delivered",
    payload: {
      id: newId("event"),
      type: "email.delivered",
      created_at: now.toISOString(),
      data: syntheticMessageData(),
    },
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    expiresAt: new Date(now.getTime() + DELIVERY_EXPIRY_MS),
  });
  return id;
}
