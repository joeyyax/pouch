import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { messageEvents, webhookDeliveries } from "@/lib/db/schema";
import { acceptMessage } from "@/lib/messages/create";
import { createEndpoint } from "@/lib/webhooks/endpoints";
import { claimDeliveries } from "@/lib/webhooks/queue";
import { deliverWebhook } from "@/worker/webhooks";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

vi.mock("node:dns/promises", () => ({
  lookup: () => Promise.resolve([{ address: "203.0.113.9", family: 4 }]),
}));

/** What the receiver answers. No socket is opened. */
let statusCode = 200;

vi.mock("@/lib/webhooks/deliver", () => ({
  REQUEST_TIMEOUT_MS: 10_000,
  postSigned: () => Promise.resolve({ statusCode, error: null, durationMs: 4 }),
}));

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  statusCode = 200;
});

async function queueDeliveryFor(messageId: string | null): Promise<void> {
  const { endpoint } = await createEndpoint({
    organizationId: fixture.organizationId,
    apiKeyId: fixture.key.id,
    url: "https://receiver.example.net/hook",
    events: ["email.delivered"],
  });
  const now = await dbNow();
  await db.insert(webhookDeliveries).values({
    id: `whd_${Math.random().toString(36).slice(2, 12)}`,
    organizationId: fixture.organizationId,
    endpointId: endpoint.id,
    messageId,
    eventType: "email.delivered",
    payload: { id: "evt_1", type: "email.delivered", created_at: new Date().toISOString(), data: {} },
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  });
}

async function deliverOnce(): Promise<void> {
  const claimed = await claimDeliveries("worker-test", 10);
  expect(claimed).toHaveLength(1);
  await deliverWebhook(claimed[0]!);
}

async function queueMessage(): Promise<string> {
  const { message } = await acceptMessage(
    fixture.key,
    { from: "Ada <ada@example.com>", to: ["person@example.net"], subject: "Hello", html: "<p>Hi</p>" },
    null,
  );
  return message.id;
}

async function occurrences(messageId: string) {
  const rows = await db.select().from(messageEvents).where(eq(messageEvents.messageId, messageId));
  return rows.filter((row) => row.kind === "webhook_delivered");
}

describe("a webhook delivery on the message timeline", () => {
  it("records the event type, the endpoint and the code it answered with", async () => {
    const messageId = await queueMessage();
    await queueDeliveryFor(messageId);

    await deliverOnce();

    const [delivered] = await occurrences(messageId);
    expect(delivered?.detail).toMatchObject({
      eventType: "email.delivered",
      url: "https://receiver.example.net/hook",
      statusCode: 200,
    });
  });

  it("says nothing when the endpoint refused it", async () => {
    statusCode = 500;
    const messageId = await queueMessage();
    await queueDeliveryFor(messageId);

    await deliverOnce();

    expect(await occurrences(messageId)).toHaveLength(0);
  });

  it("delivers a message-less event without trying to put it on a timeline", async () => {
    await queueDeliveryFor(null);

    await deliverOnce();

    const [delivery] = await db.select().from(webhookDeliveries);
    expect(delivery?.status).toBe("succeeded");
  });
});
