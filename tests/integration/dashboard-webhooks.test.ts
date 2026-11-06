import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { webhookAttempts, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { userActor } from "@/lib/activity/record";
import { listDeliveries, listEndpointViews, readDeliveryDetail } from "@/lib/dashboard/webhooks";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

let fixture: Fixture;

async function delivery(): Promise<{ endpointId: string; deliveryId: string }> {
  const endpointId = newId("webhookEndpoint");
  await db.insert(webhookEndpoints).values({
    id: endpointId,
    organizationId: fixture.organizationId,
    apiKeyId: fixture.key.id,
    url: "https://hooks.example.com/events",
    events: ["email.delivered"],
    secretEncrypted: "x",
  });
  const deliveryId = newId("webhookDelivery");
  await db.insert(webhookDeliveries).values({
    id: deliveryId,
    organizationId: fixture.organizationId,
    endpointId,
    eventType: "email.delivered",
    payload: { id: newId("event"), type: "email.delivered", data: { id: "msg_1" } },
    status: "failed",
    attempts: 1,
    lastStatusCode: 503,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  await db.insert(webhookAttempts).values({
    id: newId("webhookAttempt"),
    organizationId: fixture.organizationId,
    deliveryId,
    attempt: 1,
    statusCode: 503,
    durationMs: 120,
  });
  return { endpointId, deliveryId };
}

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

const session = (organizationId: string) => ({ organizationId, domainIds: [], actor: userActor("u_test", "Test") });

describe("webhook delivery log", () => {
  it("lists deliveries without their payloads", async () => {
    const { endpointId, deliveryId } = await delivery();
    const [row] = await listDeliveries(session(fixture.organizationId), endpointId);
    expect(row).toMatchObject({ id: deliveryId, status: "failed", lastStatusCode: 503 });
    expect(row).not.toHaveProperty("payload");
  });

  it("loads one delivery's payload and attempts, inside the organization only", async () => {
    const { endpointId, deliveryId } = await delivery();
    const detail = await readDeliveryDetail(session(fixture.organizationId), endpointId, deliveryId);
    expect(detail?.payload).toMatchObject({ type: "email.delivered" });
    expect(detail?.attempts).toEqual([expect.objectContaining({ attempt: 1, statusCode: 503 })]);

    const other = await seedFixture();
    expect(await readDeliveryDetail(session(other.organizationId), endpointId, deliveryId)).toBeNull();
  });
});

describe("a key's endpoints", () => {
  it("lists the key's endpoints through the API's read, inside the organization only", async () => {
    const { endpointId } = await delivery();
    const [endpoint] = await listEndpointViews(session(fixture.organizationId), fixture.key.id);
    expect(endpoint).toMatchObject({ id: endpointId, url: "https://hooks.example.com/events", disabled: false, lastSuccessAt: null });
    expect(endpoint?.createdAt).toBeInstanceOf(Date);

    const other = await seedFixture();
    expect(await listEndpointViews(session(other.organizationId), fixture.key.id)).toEqual([]);
  });
});
