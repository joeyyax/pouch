import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { createEndpoint } from "@/lib/webhooks/endpoints";
import { claimDeliveries } from "@/lib/webhooks/queue";
import { CONSECUTIVE_EXHAUSTED_LIMIT, deliverWebhook } from "@/worker/webhooks";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

/** What the next dns lookup does. Registration always needs a public answer; delivery varies. */
let lookupResult: "public" | "private" | "unresolvable" = "public";

vi.mock("node:dns/promises", () => ({
  lookup: () => {
    if (lookupResult === "unresolvable") return Promise.reject(new Error("ENOTFOUND"));
    const address = lookupResult === "private" ? "10.0.0.7" : "203.0.113.9";
    return Promise.resolve([{ address, family: 4 }]);
  },
}));

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  lookupResult = "public";
});

/** Queues one pending delivery against an endpoint, ready to claim. */
async function queueFor(endpointId: string): Promise<string> {
  const now = await dbNow();
  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      id: `whd_${Math.random().toString(36).slice(2, 12)}`,
      organizationId: fixture.organizationId,
      endpointId,
      messageId: null,
      eventType: "email.delivered",
      payload: { id: "evt_1", type: "email.delivered", created_at: new Date().toISOString(), data: {} },
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    })
    .returning();

  return delivery!.id;
}

/** Registers an endpoint and queues one delivery against it. */
async function queuedDelivery(): Promise<string> {
  const { endpoint } = await createEndpoint({
    organizationId: fixture.organizationId,
    apiKeyId: fixture.key.id,
    url: "https://receiver.example.net/hook",
    events: ["email.delivered"],
  });
  return queueFor(endpoint.id);
}

async function deliverOnce(): Promise<void> {
  const claimed = await claimDeliveries("worker-test", 10);
  expect(claimed).toHaveLength(1);
  await deliverWebhook(claimed[0]!);
}

describe("a delivery whose host doesn't resolve", () => {
  it("retries on the backoff schedule instead of exhausting on the first attempt", async () => {
    const id = await queuedDelivery();
    lookupResult = "unresolvable";
    const before = Date.now();

    await deliverOnce();

    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(1);
    // 30 seconds is the first step of the schedule; anything at or before now means no retry.
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(before);
  });

  it("leaves the endpoint enabled through a whole outage, not just the first failure", async () => {
    // More failures than CONSECUTIVE_EXHAUSTED_LIMIT: on the old behaviour each one exhausted
    // on its first attempt, so a single DNS outage was enough to disable a healthy receiver.
    const { endpoint } = await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://receiver.example.net/hook",
      events: ["email.delivered"],
    });
    for (let i = 0; i < CONSECUTIVE_EXHAUSTED_LIMIT + 1; i += 1) await queueFor(endpoint.id);

    lookupResult = "unresolvable";
    const claimed = await claimDeliveries("worker-test", 20);
    expect(claimed).toHaveLength(CONSECUTIVE_EXHAUSTED_LIMIT + 1);
    for (const item of claimed) await deliverWebhook(item);

    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
    expect(row!.disabledAt).toBeNull();
  });
});

describe("a delivery whose host resolves to a private address", () => {
  it("exhausts immediately rather than retrying a URL it must never call", async () => {
    const id = await queuedDelivery();
    lookupResult = "private";

    await deliverOnce();

    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
    expect(row!.status).toBe("exhausted");
    expect(row!.lastError).toContain("private address");
  });
});
