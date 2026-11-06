import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, messages, webhookDeliveries } from "@/lib/db/schema";
import { revokeApiKey } from "@/lib/api/key-lifecycle";
import { apiKeyActor } from "@/lib/activity/record";
import { enqueueDomainScopedWebhookEvent, enqueueOrganizationWebhookEvent } from "@/lib/webhooks/dispatch";
import { createWebhookEndpoint } from "@/lib/webhooks/manage";
import { claimDeliveries } from "@/lib/webhooks/queue";
import { acceptMessage } from "@/lib/messages/create";
import { applyEvent } from "@/lib/messages/events";
import { createEndpoint, rotateSecret } from "@/lib/webhooks/endpoints";
import { sign } from "@/lib/webhooks/sign";
import { deliverWebhook } from "@/worker/webhooks";
import type { NormalizedEvent } from "@/lib/providers/adapters/types";
import { eventSource, resetDatabase, seedFixture, type Fixture } from "./fixtures";

// createEndpoint checks the URL is safe to register, which resolves the hostname — stub it to a
// public address so the test doesn't depend on real DNS for example.net.
vi.mock("node:dns/promises", () => ({ lookup: () => Promise.resolve([{ address: "203.0.113.9", family: 4 }]) }));

const posted = vi.hoisted(() => [] as { body: string; headers: Record<string, string> }[]);
vi.mock("@/lib/webhooks/deliver", () => ({
  postSigned: (_target: unknown, body: string, headers: Record<string, string>) => {
    posted.push({ body, headers });
    return Promise.resolve({ statusCode: 200, error: null, durationMs: 1 });
  },
}));

// Runs once right after applyEvent commits, so a test can land a second event in that gap.
const afterCommit = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock("@/lib/messages/updates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/messages/updates")>();
  return {
    ...actual,
    publishMessageUpdate: async (...args: Parameters<typeof actual.publishMessageUpdate>) => {
      const run = afterCommit.run;
      afterCommit.run = null;
      if (run) await run();
      return actual.publishMessageUpdate(...args);
    },
  };
});

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    providerMessageId: "provider-1",
    providerEventId: "event-1",
    status: "delivered",
    reason: null,
    occurredAt: new Date(),
    detail: {},
    recipients: [],
    ...overrides,
  };
}

async function sentMessage(fixture: Fixture, to = "person@example.net"): Promise<string> {
  const { message } = await acceptMessage(
    fixture.key,
    { from: "Ada <ada@example.com>", to: [to], subject: "Hello", html: "<p>Hi</p>" },
    null,
  );
  await db
    .update(messages)
    .set({ status: "sent", providerId: fixture.providerId, providerMessageId: "provider-1", sentAt: new Date() })
    .where(eq(messages.id, message.id));
  return message.id;
}

async function deliveriesFor(organizationId: string) {
  return db.select().from(webhookDeliveries).where(eq(webhookDeliveries.organizationId, organizationId));
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  afterCommit.run = null;
  posted.length = 0;
});

describe("enqueueWebhooks (via applyEvent)", () => {
  it("is a no-op when the key has no matching endpoint", async () => {
    await sentMessage(fixture);
    await applyEvent(eventSource(fixture), event());
    expect(await deliveriesFor(fixture.organizationId)).toHaveLength(0);
  });

  it("is a no-op when an endpoint exists but isn't subscribed to this event", async () => {
    await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://example.net/hook",
      events: ["email.bounced"],
    });
    await sentMessage(fixture);
    await applyEvent(eventSource(fixture), event({ status: "delivered" }));
    expect(await deliveriesFor(fixture.organizationId)).toHaveLength(0);
  });

  it("enqueues one delivery per subscribed endpoint, with the message shape as data", async () => {
    await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://example.net/hook",
      events: ["email.delivered", "email.bounced"],
    });
    const messageId = await sentMessage(fixture);

    await applyEvent(eventSource(fixture), event());

    const rows = await deliveriesFor(fixture.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("email.delivered");
    expect(rows[0]?.messageId).toBe(messageId);
    expect(rows[0]?.status).toBe("pending");

    const payload = rows[0]?.payload as { type: string; data: { id: string; status: string } };
    expect(payload.type).toBe("email.delivered");
    expect(payload.data.id).toBe(messageId);
    expect(payload.data.status).toBe("delivered");
  });

  it("reports the message as it was when the event applied, not after a later event", async () => {
    await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://example.net/hook",
      events: ["email.delivered", "email.complained"],
    });
    await sentMessage(fixture);
    afterCommit.run = async () => {
      await applyEvent(eventSource(fixture), event({ providerEventId: "event-2", status: "complained" }));
    };

    await applyEvent(eventSource(fixture), event());

    const rows = await deliveriesFor(fixture.organizationId);
    const delivered = rows.find((row) => row.eventType === "email.delivered");
    const payload = delivered?.payload as { data: { status: string } };
    expect(payload.data.status).toBe("delivered");
    expect(rows.find((row) => row.eventType === "email.complained")).toBeDefined();
  });

  it("doesn't enqueue a second delivery when the provider retries the same event", async () => {
    await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://example.net/hook",
      events: ["email.delivered"],
    });
    await sentMessage(fixture);

    const first = await applyEvent(eventSource(fixture), event());
    const second = await applyEvent(eventSource(fixture), event());

    expect(first.outcome).toBe("recorded");
    expect(second.outcome).toBe("duplicate");
    expect(await deliveriesFor(fixture.organizationId)).toHaveLength(1);
  });
});

describe("a revoked key's endpoints", () => {
  async function revokedWithEndpoint() {
    const { endpoint } = await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://example.net/hook",
      events: ["email.delivered", "email.unsubscribed", "domain.reputation_changed"],
    });
    return endpoint;
  }

  it("get nothing new, from a message, a domain event or an organization event", async () => {
    await revokedWithEndpoint();
    await db.update(apiKeys).set({ domainIds: [] }).where(eq(apiKeys.id, fixture.key.id));
    await sentMessage(fixture);
    await revokeApiKey(fixture.organizationId, fixture.key.id);

    await applyEvent(eventSource(fixture), event());
    const base = { eventId: "evt_1", occurredAt: new Date(), data: {} };
    await enqueueDomainScopedWebhookEvent(fixture.organizationId, { ...base, eventType: "email.unsubscribed", domainId: fixture.domainId });
    await enqueueOrganizationWebhookEvent(fixture.organizationId, { ...base, eventType: "domain.reputation_changed" });

    expect(await deliveriesFor(fixture.organizationId)).toHaveLength(0);
  });

  it("don't get what was already queued, and can't be given a new endpoint", async () => {
    await revokedWithEndpoint();
    await sentMessage(fixture);
    await applyEvent(eventSource(fixture), event());
    expect(await deliveriesFor(fixture.organizationId)).toHaveLength(1);

    await revokeApiKey(fixture.organizationId, fixture.key.id);

    expect(await claimDeliveries("worker-test", 10)).toEqual([]);
    expect((await deliveriesFor(fixture.organizationId)).map((delivery) => delivery.status)).toEqual(["exhausted"]);
    await expect(
      createWebhookEndpoint(
        { organizationId: fixture.organizationId, domainIds: [], actor: apiKeyActor(fixture.key.id, "test") },
        { key_id: fixture.key.id, url: "https://example.net/other", events: ["email.delivered"] },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("don't keep a delivery queued while the revoke was committing", async () => {
    await revokedWithEndpoint();
    await sentMessage(fixture);
    await applyEvent(eventSource(fixture), event());
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, fixture.key.id));

    expect(await claimDeliveries("worker-test", 10)).toEqual([]);
    expect((await deliveriesFor(fixture.organizationId)).map((delivery) => delivery.status)).toEqual(["exhausted"]);
  });

  it("still claims deliveries for a key that isn't revoked", async () => {
    await revokedWithEndpoint();
    await sentMessage(fixture);
    await applyEvent(eventSource(fixture), event());
    expect(await claimDeliveries("worker-test", 10)).toHaveLength(1);
  });
});

describe("signing email.* deliveries", () => {
  async function deliverAll(): Promise<void> {
    for (const claimed of await claimDeliveries("worker-test", 10)) await deliverWebhook(claimed);
  }

  it("signs the body with the endpoint's secret and the timestamp it sends", async () => {
    const { secret } = await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://example.net/hook",
      events: ["email.delivered"],
    });
    await sentMessage(fixture);
    await applyEvent(eventSource(fixture), event());

    await deliverAll();

    expect(posted).toHaveLength(1);
    const { body, headers } = posted[0]!;
    expect(headers["X-Webhook-Event"]).toBe("email.delivered");
    expect(headers["X-Signature"]).toBe(sign(secret, Number(headers["X-Timestamp"]), body));
    expect((JSON.parse(body) as { type: string }).type).toBe("email.delivered");
  });

  it("signs with the new secret once rotated, and the old one no longer verifies", async () => {
    const { endpoint, secret: old } = await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://example.net/hook",
      events: ["email.delivered"],
    });
    const rotated = await rotateSecret(fixture.organizationId, endpoint.id);
    await sentMessage(fixture);
    await applyEvent(eventSource(fixture), event());

    await deliverAll();

    expect(posted).toHaveLength(1);
    const { body, headers } = posted[0]!;
    const timestamp = Number(headers["X-Timestamp"]);
    expect(rotated).not.toBe(old);
    expect(headers["X-Signature"]).toBe(sign(rotated!, timestamp, body));
    expect(headers["X-Signature"]).not.toBe(sign(old, timestamp, body));
  });
});
