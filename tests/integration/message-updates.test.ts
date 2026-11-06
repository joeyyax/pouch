import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { acceptMessage } from "@/lib/messages/create";
import { applyEvent } from "@/lib/messages/events";
import { publishMessageUpdate, updatesChannel, type MessageUpdate } from "@/lib/messages/updates";
import { closeRedis } from "@/lib/redis";
import { newId } from "@/lib/ids";
import { eq } from "drizzle-orm";
import { eventSource, resetDatabase, seedFixture, type Fixture } from "./fixtures";
import { testRedisUrl } from "../redis";

/** The compose Redis. Live updates are the one thing that can't be proved without it. */
const REDIS_URL = testRedisUrl();

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

afterAll(() => {
  delete process.env.REDIS_URL;
});

/** Collects updates on the organization's channel until `done` is satisfied or the wait runs out. */
async function listen(
  organizationId: string,
  done: (seen: MessageUpdate[]) => boolean,
  run: () => Promise<void>,
): Promise<MessageUpdate[]> {
  const subscriber = new Redis(REDIS_URL);
  const seen: MessageUpdate[] = [];
  const { promise, resolve } = Promise.withResolvers<void>();

  subscriber.on("message", (_channel, payload) => {
    seen.push(JSON.parse(payload) as MessageUpdate);
    if (done(seen)) resolve();
  });

  await subscriber.subscribe(updatesChannel(organizationId));
  try {
    await run();
    await Promise.race([promise, new Promise((timeout) => setTimeout(timeout, 5000))]);
  } finally {
    await subscriber.quit().catch(() => subscriber.disconnect());
  }
  return seen;
}

/** Collects updates on the organization's channel until `count` land or the wait runs out. */
function collect(organizationId: string, count: number, run: () => Promise<void>): Promise<MessageUpdate[]> {
  return listen(organizationId, (seen) => seen.length >= count, run);
}

/** Everything `run` publishes to the channel, with nothing more to wait for once a trailing marker lands behind it. */
async function collectAll(organizationId: string, run: () => Promise<void>): Promise<MessageUpdate[]> {
  const marker = newId("message");
  const seen = await listen(organizationId, (updates) => updates.some((u) => u.messageId === marker), async () => {
    await run();
    await publishMessageUpdate(organizationId, { messageId: marker, status: "sent" });
  });
  return seen.filter((update) => update.messageId !== marker);
}

const send = (to = "sam@example.com") =>
  acceptMessage(fixture.key, { from: "hi@example.com", to: [to], subject: "Hi", html: "<p>Hi</p>" }, null);

describe("without Redis", () => {
  it("publishes nothing and breaks nothing", async () => {
    delete process.env.REDIS_URL;
    await closeRedis();

    await expect(publishMessageUpdate(fixture.organizationId, { messageId: "msg_1", status: "sent" })).resolves
      .toBeUndefined();
    // The write it follows still lands.
    const { message } = await send();
    expect(message.status).toBe("queued");
  });
});

describe("with Redis", () => {
  beforeEach(async () => {
    await closeRedis();
    process.env.REDIS_URL = REDIS_URL;
  });

  it("announces a message the moment it's accepted", async () => {
    let accepted = "";
    const seen = await collect(fixture.organizationId, 1, async () => {
      const { message } = await send();
      accepted = message.id;
    });

    expect(seen).toEqual([{ messageId: accepted, status: "queued" }]);
  });

  it("announces a provider event once it's committed", async () => {
    const { message } = await send();
    await db.update(messages).set({ status: "sent", providerId: fixture.providerId, providerMessageId: "prov_1" }).where(eq(messages.id, message.id));

    const seen = await collect(fixture.organizationId, 1, async () => {
      await applyEvent(eventSource(fixture), {
        providerMessageId: "prov_1",
        providerEventId: "evt_1",
        status: "delivered",
        reason: "250 2.0.0 OK",
        occurredAt: new Date(),
        detail: {},
        recipients: [],
      });
    });

    expect(seen).toEqual([{ messageId: message.id, status: "delivered" }]);
  });

  it("says nothing for an event it already applied", async () => {
    const { message } = await send();
    await db.update(messages).set({ status: "sent", providerId: fixture.providerId, providerMessageId: "prov_2" }).where(eq(messages.id, message.id));

    const event = {
      providerMessageId: "prov_2",
      providerEventId: "evt_2",
      status: "delivered" as const,
      reason: null,
      occurredAt: new Date(),
      detail: {},
      recipients: [],
    };
    await applyEvent(eventSource(fixture), event);

    const seen = await collectAll(fixture.organizationId, async () => {
      const outcome = await applyEvent(eventSource(fixture), event);
      expect(outcome.outcome).toBe("duplicate");
    });

    expect(seen).toEqual([]);
  });

  it("keeps each organization on its own channel", async () => {
    const other = await seedFixture();
    expect(updatesChannel(fixture.organizationId)).not.toBe(updatesChannel(other.organizationId));

    const seen = await collectAll(other.organizationId, async () => {
      await send();
      await publishMessageUpdate(fixture.organizationId, { messageId: newId("message"), status: "sent" });
    });

    expect(seen).toEqual([]);
  });
});
