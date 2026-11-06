import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { messages, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { IDEMPOTENCY_WINDOW_MS } from "@/lib/messages/idempotency";
import { acceptMessage } from "@/lib/messages/create";
import { claimMessages, dueProviders } from "@/lib/messages/queue";
import { createEndpoint, setDisabled } from "@/lib/webhooks/endpoints";
import { enqueueWebhooks } from "@/lib/webhooks/dispatch";
import { claimDeliveries } from "@/lib/webhooks/queue";
import { CONSECUTIVE_EXHAUSTED_LIMIT, deliverWebhook } from "@/worker/webhooks";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

/** What the next dns lookup does. Registration needs a public answer; delivery varies. */
let lookupResult: "public" | "unresolvable" = "public";

vi.mock("node:dns/promises", () => ({
  lookup: () =>
    lookupResult === "unresolvable"
      ? Promise.reject(new Error("ENOTFOUND"))
      : Promise.resolve([{ address: "203.0.113.9", family: 4 }]),
}));

/** What the receiver answers. 410 is the status that exhausts a delivery immediately. */
let webhookStatusCode = 200;

vi.mock("@/lib/webhooks/deliver", () => ({
  REQUEST_TIMEOUT_MS: 10_000,
  postSigned: () => Promise.resolve({ statusCode: webhookStatusCode, error: null, durationMs: 4 }),
}));

/** Far enough past the millisecond noise between two machines to be unambiguous. */
const SKEW_MS = 2_000;
/** The first step of lib/webhooks/backoff.ts's schedule. */
const FIRST_BACKOFF_MS = 30_000;

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  lookupResult = "public";
  webhookStatusCode = 200;
});
afterEach(() => vi.useRealTimers());

/** Runs `body` with the node clock shifted `ms` away from the database's. */
async function withNodeClockSkew<T>(ms: number, body: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(Date.now() + ms));
  try {
    return await body();
  } finally {
    vi.useRealTimers();
  }
}

describe("work is due on the database's clock, not the app's", () => {
  it("claims a message the app just accepted, with the node clock ahead", async () => {
    await withNodeClockSkew(SKEW_MS, async () => {
      await acceptMessage(
        fixture.key,
        { from: "sender@example.com", to: ["recipient@example.net"], subject: "due now", html: "<p>due now</p>" },
        null,
      );

      const providers = await dueProviders();
      expect(providers).toHaveLength(1);

      const claimed = await claimMessages({ workerId: "worker-skew", providerId: providers[0]!.id, limit: 10 });
      expect(claimed).toHaveLength(1);
    });
  });

  it("claims a webhook delivery the app just enqueued, with the node clock ahead", async () => {
    await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://receiver.example.net/hook",
      events: ["email.delivered"],
    });

    const { message } = await acceptMessage(
      fixture.key,
      { from: "sender@example.com", to: ["recipient@example.net"], subject: "webhook", html: "<p>webhook</p>" },
      null,
    );

    await withNodeClockSkew(SKEW_MS, async () => {
      const queued = await enqueueWebhooks(fixture.organizationId, {
        eventId: "evt_skew",
        eventType: "email.delivered",
        occurredAt: new Date(),
        message,
      });
      expect(queued).toBe(1);

      const claimed = await claimDeliveries("worker-skew", 10);
      expect(claimed).toHaveLength(1);
    });
  });

  it("schedules a webhook retry from the database's clock, not the app's", async () => {
    const { endpoint } = await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://receiver.example.net/hook",
      events: ["email.delivered"],
    });

    const { message } = await acceptMessage(
      fixture.key,
      { from: "sender@example.com", to: ["recipient@example.net"], subject: "retry", html: "<p>retry</p>" },
      null,
    );
    await enqueueWebhooks(fixture.organizationId, {
      eventId: "evt_retry",
      eventType: "email.delivered",
      occurredAt: new Date(),
      message,
    });

    await withNodeClockSkew(SKEW_MS, async () => {
      lookupResult = "unresolvable";
      const claimed = await claimDeliveries("worker-skew", 10);
      expect(claimed).toHaveLength(1);
      await deliverWebhook(claimed[0]!);
    });

    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, endpoint.id));
    const scheduled = row!.nextAttemptAt.getTime() - (await dbNow()).getTime();
    // First backoff step is 30s. The app's clock was SKEW_MS ahead; if that leaked into the
    // write, the retry lands SKEW_MS late and this margin catches it.
    expect(Math.abs(scheduled - FIRST_BACKOFF_MS)).toBeLessThan(SKEW_MS / 2);
  });

  it("replays a message inside the window on the database's clock, node clock ahead", async () => {
    const fixture = await seedFixture();
    const first = await acceptMessage(
      fixture.key,
      { from: "sender@example.com", to: ["recipient@example.net"], subject: "near window", html: "<p>near window</p>" },
      "near-window",
    );

    // Margin left before the message ages out, measured against the database's clock.
    const marginMs = 2_000;
    const nodeAheadMs = 10_000;
    const dbClockNow = await dbNow();
    await db
      .update(messages)
      .set({ createdAt: new Date(dbClockNow.getTime() - (IDEMPOTENCY_WINDOW_MS - marginMs)) })
      .where(eq(messages.id, first.message.id));

    // The node clock is far enough ahead of the database's that comparing against Date.now()
    // pushes the message past the window it hasn't actually reached yet.
    await withNodeClockSkew(nodeAheadMs, async () => {
      const replay = await acceptMessage(
        fixture.key,
        { from: "sender@example.com", to: ["recipient@example.net"], subject: "near window", html: "<p>near window</p>" },
        "near-window",
      );
      expect(replay.replayed).toBe(true);
      expect(replay.message.id).toBe(first.message.id);
    });
  });

  it("auto-disables an endpoint with disabledAt from the database's clock, node clock ahead", async () => {
    const { endpoint } = await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://receiver.example.net/hook",
      events: ["email.delivered"],
    });

    const { message } = await acceptMessage(
      fixture.key,
      { from: "sender@example.com", to: ["recipient@example.net"], subject: "disable", html: "<p>disable</p>" },
      null,
    );
    // 410 exhausts a delivery on its first attempt, so CONSECUTIVE_EXHAUSTED_LIMIT deliveries
    // disable the endpoint in one pass.
    webhookStatusCode = 410;

    await withNodeClockSkew(SKEW_MS, async () => {
      for (let i = 0; i < CONSECUTIVE_EXHAUSTED_LIMIT; i += 1) {
        await enqueueWebhooks(fixture.organizationId, {
          eventId: `evt_disable_${i}`,
          eventType: "email.delivered",
          occurredAt: new Date(),
          message,
        });
      }

      const claimed = await claimDeliveries("worker-skew", 20);
      expect(claimed).toHaveLength(CONSECUTIVE_EXHAUSTED_LIMIT);
      for (const item of claimed) await deliverWebhook(item);
    });

    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
    expect(row!.disabledAt).not.toBeNull();
    const disabledSkew = row!.disabledAt!.getTime() - (await dbNow()).getTime();
    // The app's clock was SKEW_MS ahead; if that leaked into the write, disabledAt lands
    // SKEW_MS in the future relative to the database's own clock.
    expect(Math.abs(disabledSkew)).toBeLessThan(SKEW_MS / 2);
  });

  it("records a manual disable's disabledAt from the database's clock, node clock ahead", async () => {
    const { endpoint } = await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://receiver.example.net/hook",
      events: ["email.delivered"],
    });

    await withNodeClockSkew(SKEW_MS, async () => {
      const disabled = await setDisabled(fixture.organizationId, endpoint.id, true);
      expect(disabled?.disabledAt).not.toBeNull();
    });

    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
    const disabledSkew = row!.disabledAt!.getTime() - (await dbNow()).getTime();
    expect(Math.abs(disabledSkew)).toBeLessThan(SKEW_MS / 2);
  });
});
