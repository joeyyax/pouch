/**
 * How fast the worker drains due webhook deliveries against endpoints that answer in a set time.
 * Not part of `pnpm test`: run `pnpm test:load`. LOAD_WEBHOOKS sets the count, MOCK_SEND_LATENCY_MS the endpoint's answer time.
 */
import { appendFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { count, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { webhookDeliveries } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { createEndpoint } from "@/lib/webhooks/endpoints";
import { WebhookLoop } from "@/worker/webhooks";
import { resetDatabase, seedFixture } from "../integration/fixtures";

const DELIVERIES = Number(process.env.LOAD_WEBHOOKS ?? 1000);
const LATENCY_MS = Number(process.env.MOCK_SEND_LATENCY_MS ?? 150);

vi.mock("node:dns/promises", () => ({ lookup: () => Promise.resolve([{ address: "203.0.113.9", family: 4 }]) }));
vi.mock("@/lib/webhooks/deliver", async (original) => ({
  ...(await original<typeof import("@/lib/webhooks/deliver")>()),
  postSigned: () => new Promise((resolve) => setTimeout(() => resolve({ statusCode: 200, error: null, durationMs: LATENCY_MS }), LATENCY_MS)),
}));

describe("webhook throughput", () => {
  it(`delivers ${DELIVERIES} webhooks`, async () => {
    await resetDatabase();
    const fixture = await seedFixture();
    const { endpoint } = await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://receiver.example.net/hook",
      events: ["email.delivered"],
    });
    const now = await dbNow();
    for (let i = 0; i < DELIVERIES; i += 500) {
      await db.insert(webhookDeliveries).values(
        Array.from({ length: Math.min(500, DELIVERIES - i) }, () => ({
          id: newId("webhookDelivery"),
          organizationId: fixture.organizationId,
          endpointId: endpoint.id,
          messageId: null,
          eventType: "email.delivered" as const,
          payload: { id: "evt_1", type: "email.delivered", created_at: now.toISOString(), data: {} },
          status: "pending" as const,
          attempts: 0,
          nextAttemptAt: now,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        })),
      );
    }

    const loop = new WebhookLoop({ workerId: "load", intervalMs: 2000, batchSize: Number(process.env.WORKER_WEBHOOK_BATCH ?? 20) });
    const start = performance.now();
    loop.start();
    let done = 0;
    while (done < DELIVERIES && performance.now() - start < 120_000) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const [row] = await db.select({ n: count() }).from(webhookDeliveries).where(eq(webhookDeliveries.status, "succeeded"));
      done = row?.n ?? 0;
    }
    const ms = performance.now() - start;
    await loop.stop();

    appendFileSync(process.env.LOAD_REPORT ?? "/dev/stderr", `webhooks ${DELIVERIES} at ${LATENCY_MS}ms: delivered in ${(ms / 1000).toFixed(1)}s, ${(done / (ms / 1000)).toFixed(0)}/s\n\n`);
    expect(done).toBe(DELIVERIES);
  });
});
