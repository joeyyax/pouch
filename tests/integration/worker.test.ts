import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, messageEvents, messages, providers } from "@/lib/db/schema";
import { moveDomain, type DomainCaller } from "@/lib/domains";
import { userActor } from "@/lib/activity/record";
import { acceptMessage } from "@/lib/messages/create";
import { recordOccurrence } from "@/lib/messages/events";
import * as queueModule from "@/lib/messages/queue";
import { LOCK_TIMEOUT_MS, claimMessages, dueProviders } from "@/lib/messages/queue";
import { mockSends, resetMockSends } from "@/lib/providers/adapters/mock";
import { deliver, toOutbound } from "@/worker/send";
import { SendLoop } from "@/worker/loop";
import type { SendEmailRequest } from "@/lib/schemas/email";
import { listProviderHealth } from "@/lib/health/checks";
import { closeRedis } from "@/lib/redis";
import { addDomainKeyFor, addProvider, addSuppression, messageRow, resetDatabase, seedFixture, type Fixture } from "./fixtures";
import { testRedisUrl } from "../redis";

const REDIS_URL = testRedisUrl();

function request(to: string): SendEmailRequest {
  return { from: "Ada <ada@example.com>", to: [to], subject: "Hello", html: "<p>Hi</p>" };
}

async function queue(fixture: Fixture, to: string): Promise<string> {
  const { message } = await acceptMessage(fixture.key, request(to), null);
  return message.id;
}

/** Every event on a message, oldest first, the way the timeline reads it. */
async function timeline(id: string) {
  return db
    .select()
    .from(messageEvents)
    .where(eq(messageEvents.messageId, id))
    .orderBy(messageEvents.occurredAt, messageEvents.id);
}

/** Polls until the read satisfies the predicate, so a test waits on state rather than scheduling. */
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ready(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Claims across every provider with work, the way the loop does. */
async function claimAll(workerId: string, limit = 10) {
  const claimed = [];
  for (const provider of await dueProviders()) {
    claimed.push(...(await claimMessages({ workerId, providerId: provider.id, limit })));
  }
  return claimed;
}

async function claimAndDeliver(workerId = "worker-test"): Promise<number> {
  const claimed = await claimAll(workerId);
  for (const item of claimed) await deliver(item);
  return claimed.length;
}

beforeEach(async () => {
  await resetDatabase();
  resetMockSends();
});

describe("claiming", () => {
  it("claims a due queued message and locks it to the worker", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "person@example.net");

    const claimed = await claimAll("worker-a");

    expect(claimed.map((item) => item.message.id)).toEqual([id]);
    expect((await messageRow(id)).lockedBy).toBe("worker-a");
  });

  it("does not hand the same row to a second worker", async () => {
    const fixture = await seedFixture();
    await queue(fixture, "person@example.net");

    await claimAll("worker-a");
    const second = await claimAll("worker-b");

    expect(second).toHaveLength(0);
  });

  it("claims no more than the caller's limit", async () => {
    const fixture = await seedFixture();
    for (let i = 0; i < 5; i++) await queue(fixture, `person${i}@example.net`);

    const claimed = await claimAll("worker-a", 2);

    expect(claimed).toHaveLength(2);
  });

  it("skips a message whose next attempt is in the future", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "person@example.net");
    await db
      .update(messages)
      .set({ nextAttemptAt: new Date((await dbNow()).getTime() + 60_000) })
      .where(eq(messages.id, id));

    expect(await claimAll("worker-a")).toHaveLength(0);
  });

  it("reclaims a row whose lock went stale", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "person@example.net");
    await db
      .update(messages)
      .set({ lockedBy: "worker-gone", lockedAt: new Date((await dbNow()).getTime() - 10 * 60 * 1000) })
      .where(eq(messages.id, id));

    const claimed = await claimAll("worker-b");

    expect(claimed.map((item) => item.message.id)).toEqual([id]);
  });

  it("lists a provider with work waiting", async () => {
    const fixture = await seedFixture();
    await queue(fixture, "person@example.net");

    expect(await dueProviders()).toEqual([
      { id: fixture.providerId, concurrency: 4, adapter: "mock", providerIdentity: null, shared: false, sharedProviderId: null },
    ]);
  });

  it("does not list a provider that is backing off", async () => {
    const fixture = await seedFixture();
    await queue(fixture, "person@example.net");
    await db
      .update(providers)
      .set({ backoffUntil: new Date((await dbNow()).getTime() + 60_000) })
      .where(eq(providers.id, fixture.providerId));

    expect(await dueProviders()).toHaveLength(0);
    expect(await claimAll("worker-a")).toHaveLength(0);
  });

  it("does not list a provider whose messages are all done", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "person@example.net");
    await db.update(messages).set({ status: "sent" }).where(eq(messages.id, id));

    expect(await dueProviders()).toHaveLength(0);
  });

  it("carries the provider alongside each message", async () => {
    const fixture = await seedFixture();
    await queue(fixture, "person@example.net");

    const [claimed] = await claimAll("worker-a");

    expect(claimed?.provider.id).toBe(fixture.providerId);
    expect(claimed?.provider.adapter).toBe("mock");
  });
});

describe("delivery outcomes", () => {
  it("marks a successful send as sent with the provider id and a sent event", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "person@example.net");

    await claimAndDeliver();

    const message = await messageRow(id);
    expect(message.status).toBe("sent");
    expect(message.providerMessageId).toMatch(/^mock_/);
    expect(message.attempts).toBe(1);
    expect(message.lastAttemptAt).not.toBeNull();
    expect(message.sentAt).not.toBeNull();
    expect(message.lockedBy).toBeNull();

    const events = await db.select().from(messageEvents).where(eq(messageEvents.messageId, id));
    expect(events.map((event) => event.status)).toEqual(["queued", "sent"]);
  });

  it("fails a permanent rejection on the first attempt and records the reason", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "bounce@example.net");

    await claimAndDeliver();

    const message = await messageRow(id);
    expect(message.status).toBe("failed");
    expect(message.failureReason).toBe("Mailbox does not exist");
    expect(message.attempts).toBe(1);
  });

  it("never sends when the retention sweep shredded the body key", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "person@example.net");
    // The row the sweep leaves behind: key gone, stamp set.
    await db
      .update(messages)
      .set({ bodyKey: null, bodyPurgedAt: new Date(), attempts: 4 })
      .where(eq(messages.id, id));

    await claimAndDeliver();

    expect(mockSends()).toHaveLength(0);
    const message = await messageRow(id);
    expect(message.status).toBe("failed");
    expect(message.failureReason).toContain("no body key");
  });

  it("keeps a transient rejection queued and pushes the next attempt out", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "defer@example.net");

    await claimAndDeliver();

    const message = await messageRow(id);
    expect(message.status).toBe("queued");
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt.getTime()).toBeGreaterThan((await dbNow()).getTime());
    expect(message.lockedBy).toBeNull();
  });

  it("fails a transient rejection once the attempt budget runs out", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "defer@example.net");
    await db.update(messages).set({ attempts: 4 }).where(eq(messages.id, id));

    await claimAndDeliver();

    const message = await messageRow(id);
    expect(message.status).toBe("failed");
    expect(message.attempts).toBe(5);
  });
});

describe("unexpected failures", () => {
  it("spends an attempt and backs off when the provider throws, rather than hot-looping", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    const id = await queue(fixture, "person@example.net");
    // A provider whose credentials no longer decrypt makes the send throw.
    await db
      .update(providers)
      .set({ credentials: "v1.notreal.notreal.notreal" })
      .where(eq(providers.id, fixture.providerId));

    await claimAndDeliver();

    const message = await messageRow(id);
    expect(message.status).toBe("queued");
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt.getTime()).toBeGreaterThan((await dbNow()).getTime());
    expect(message.lockedBy).toBeNull();
  });

  it("retries rather than sending an empty body when the stored body can't be read", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "person@example.net");
    await db.update(messages).set({ storageKey: "bodies/missing/2026-01-01/msg_gone" }).where(eq(messages.id, id));

    await claimAndDeliver();

    const message = await messageRow(id);
    expect(message.status).toBe("queued");
    expect(message.attempts).toBe(1);
    expect(mockSends()).toHaveLength(0);
  });

  it("fails the message once the attempt budget runs out", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    const id = await queue(fixture, "person@example.net");
    await db.update(messages).set({ attempts: 4 }).where(eq(messages.id, id));
    await db
      .update(providers)
      .set({ credentials: "v1.notreal.notreal.notreal" })
      .where(eq(providers.id, fixture.providerId));

    await claimAndDeliver();

    const message = await messageRow(id);
    expect(message.status).toBe("failed");
    expect(message.attempts).toBe(5);

    const events = await db.select().from(messageEvents).where(eq(messageEvents.messageId, id));
    expect(events.map((event) => event.status)).toContain("failed");
  });
});

describe("lock ownership", () => {
  it("writes nothing when the worker lost its lock to another worker", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "person@example.net");
    const claimed = await claimAll("worker-a");
    await db.update(messages).set({ lockedBy: "worker-b" }).where(eq(messages.id, id));

    for (const item of claimed) await deliver(item, "worker-a");

    const message = await messageRow(id);
    expect(message.status).toBe("queued");
    expect(message.lockedBy).toBe("worker-b");
  });

  it("cannot be re-sent by a second worker once a held send outlives the lock timeout", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "person@example.net");

    const [claimedA] = await claimAll("worker-a");
    if (!claimedA) throw new Error("expected worker-a to claim the row");

    // worker-a's send is still in flight when the lock ages past the timeout.
    await db
      .update(messages)
      .set({ lockedAt: new Date((await dbNow()).getTime() - LOCK_TIMEOUT_MS - 1000) })
      .where(eq(messages.id, id));

    const [claimedB] = await claimAll("worker-b");
    if (!claimedB) throw new Error("expected worker-b to reclaim the stale row");
    await deliver(claimedB, "worker-b");

    // worker-a's original send now finishes and tries to record its own outcome.
    await deliver(claimedA, "worker-a");

    const message = await messageRow(id);
    expect(message.status).toBe("sent");
    expect(message.lockedBy).toBeNull();

    const events = await db.select().from(messageEvents).where(eq(messageEvents.messageId, id));
    expect(events.filter((event) => event.status === "sent")).toHaveLength(1);
  });

  it("records the attempt before the provider call, so a crash mid-call is visible on reclaim", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    const id = await queue(fixture, "person@example.net");
    const claimed = await claimAll("worker-a");

    let releaseFetch = () => {};
    const held = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      await held;
      return new Response(JSON.stringify({ id: 1, status: "queued" }), { status: 200 });
    };

    const delivering = (async () => {
      for (const item of claimed) await deliver(item, "worker-a");
    })();

    try {
      // Wait for the pre-write to land while the provider call is still in flight.
      const midFlight = await until(() => messageRow(id), (message) => message.attempts === 1);
      expect(midFlight.status).toBe("queued");
      expect(midFlight.attempts).toBe(1);
      expect(midFlight.lastAttemptAt).not.toBeNull();
    } finally {
      releaseFetch();
      await delivering;
      globalThis.fetch = originalFetch;
    }

    expect((await messageRow(id)).status).toBe("sent");
  });

  it("does not call the provider once the lock has moved to another worker", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "person@example.net");
    const [claimed] = await claimAll("worker-a");
    if (!claimed) throw new Error("expected worker-a to claim the row");

    await db.update(messages).set({ lockedBy: "worker-b", lockedAt: await dbNow() }).where(eq(messages.id, id));
    await deliver(claimed, "worker-a");

    expect(mockSends()).toHaveLength(0);
    expect((await messageRow(id)).lockedBy).toBe("worker-b");
  });

  it("resolves when the attempt pre-write fails instead of rejecting", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "person@example.net");
    const [claimed] = await claimAll("worker-a");
    if (!claimed) throw new Error("expected worker-a to claim the row");

    // An attempt count Postgres rejects makes the pre-write fail before the provider is called.
    const poisoned = { ...claimed, message: { ...claimed.message, attempts: Number.NaN } };

    await expect(deliver(poisoned, "worker-a")).resolves.toBeUndefined();

    const message = await messageRow(id);
    expect(message.status).toBe("queued");
    expect(message.attempts).toBe(0);
    expect(mockSends()).toHaveLength(0);
  });
});

describe("provider backoff", () => {
  it("pauses the provider and leaves the message queued without spending an attempt", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "slow@example.net");

    await claimAndDeliver();

    const message = await messageRow(id);
    expect(message.status).toBe("queued");
    expect(message.attempts).toBe(0);

    const [provider] = await db
      .select()
      .from(providers)
      .where(eq(providers.id, fixture.providerId));
    expect(provider?.backoffUntil?.getTime()).toBeGreaterThan((await dbNow()).getTime());
  });

  it("stamps backingOffSince the first time the provider starts backing off", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "slow@example.net");

    const before = await dbNow();
    await claimAndDeliver();
    const after = await messageRow(id);
    expect(after.status).toBe("queued");

    const [provider] = await db.select().from(providers).where(eq(providers.id, fixture.providerId));
    expect(provider?.backingOffSince).not.toBeNull();
    expect(provider!.backingOffSince!.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("leaves backingOffSince alone while a backoff run is still in progress", async () => {
    const fixture = await seedFixture();
    await queue(fixture, "slow@example.net");
    await claimAndDeliver();
    const [firstPass] = await db.select().from(providers).where(eq(providers.id, fixture.providerId));
    const since = firstPass!.backingOffSince;
    expect(since).not.toBeNull();

    // The provider is still backing off — a second message hitting the same limit doesn't
    // push the start of the run forward.
    await db.update(providers).set({ backoffUntil: new Date(Date.now() + 60_000) }).where(eq(providers.id, fixture.providerId));
    await queue(fixture, "slow@example.net");
    await claimAndDeliver();

    const [secondPass] = await db.select().from(providers).where(eq(providers.id, fixture.providerId));
    expect(secondPass?.backingOffSince?.getTime()).toBe(since!.getTime());
  });

  it("clears backingOffSince once a send on the provider succeeds", async () => {
    const fixture = await seedFixture();
    await queue(fixture, "slow@example.net");
    await claimAndDeliver();
    const [backingOff] = await db.select().from(providers).where(eq(providers.id, fixture.providerId));
    expect(backingOff?.backingOffSince).not.toBeNull();

    // The provider's own backoff has passed, and the next send succeeds outright.
    await db.update(providers).set({ backoffUntil: null }).where(eq(providers.id, fixture.providerId));
    await queue(fixture, "person@example.net");
    await claimAndDeliver();

    const [after] = await db.select().from(providers).where(eq(providers.id, fixture.providerId));
    expect(after?.backingOffSince).toBeNull();
  });

  it("holds every message on the provider, not only the one that hit the limit", async () => {
    const fixture = await seedFixture();
    await queue(fixture, "slow@example.net");
    const other = await queue(fixture, "person@example.net");

    const claimed = await claimAll("worker-a", 1);
    for (const item of claimed) await deliver(item);

    expect(await claimAll("worker-b")).toHaveLength(0);
    expect((await messageRow(other)).status).toBe("queued");
  });
});

describe("the timeline", () => {
  it("shows nothing but the lifecycle on a message that sends first time", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "person@example.net");

    await claimAndDeliver();

    const events = await timeline(id);
    expect(events.map((event) => [event.kind, event.status])).toEqual([
      ["transition", "queued"],
      ["transition", "sent"],
    ]);
  });

  it("keeps every failed attempt, with its reason and when the next one is due", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "defer@example.net");

    await claimAndDeliver();
    await db.update(messages).set({ nextAttemptAt: await dbNow() }).where(eq(messages.id, id));
    await claimAndDeliver();

    const retries = (await timeline(id)).filter((event) => event.kind === "retry");
    expect(retries.map((event) => event.detail.attempt)).toEqual([1, 2]);
    expect(retries.map((event) => event.reason)).toEqual([
      "Temporary failure, try again",
      "Temporary failure, try again",
    ]);
    expect(retries.every((event) => Date.parse(String(event.detail.nextAttemptAt)) > 0)).toBe(true);
    expect(retries.every((event) => event.status === null)).toBe(true);
  });

  it("records a retry when the send throws rather than being rejected", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    const id = await queue(fixture, "person@example.net");
    await db
      .update(providers)
      .set({ credentials: "v1.notreal.notreal.notreal" })
      .where(eq(providers.id, fixture.providerId));

    await claimAndDeliver();

    const retries = (await timeline(id)).filter((event) => event.kind === "retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]?.detail.attempt).toBe(1);
  });

  it("says the provider is backing off, and until when", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "slow@example.net");

    await claimAndDeliver();

    const [backoff] = (await timeline(id)).filter((event) => event.kind === "backoff");
    expect(backoff?.reason).toBe("You are sending emails too quickly");
    expect(Date.parse(String(backoff?.detail.until))).toBeGreaterThan((await dbNow()).getTime());
  });

  it("counts repeated backoffs into one row instead of a row each", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "slow@example.net");

    for (let i = 0; i < 3; i++) {
      await db.update(providers).set({ backoffUntil: null }).where(eq(providers.id, fixture.providerId));
      await db.update(messages).set({ nextAttemptAt: await dbNow() }).where(eq(messages.id, id));
      await claimAndDeliver();
    }

    const backoffs = (await timeline(id)).filter((event) => event.kind === "backoff");
    expect(backoffs).toHaveLength(1);
    expect(backoffs[0]?.detail.count).toBe(3);
  });

  it("starts a new backoff row when something happened in between", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "slow@example.net");

    await claimAndDeliver();
    await recordOccurrence({
      organizationId: fixture.organizationId,
      messageId: id,
      kind: "retry",
      detail: { attempt: 1, nextAttemptAt: new Date().toISOString() },
    });
    await db.update(providers).set({ backoffUntil: null }).where(eq(providers.id, fixture.providerId));
    await db.update(messages).set({ nextAttemptAt: await dbNow() }).where(eq(messages.id, id));
    await claimAndDeliver();

    expect((await timeline(id)).filter((event) => event.kind === "backoff")).toHaveLength(2);
  });
});

describe("per-provider concurrency", () => {
  it("claims no more than the provider allows in one pass", async () => {
    const fixture = await seedFixture({ concurrency: 2 });
    for (let i = 0; i < 5; i++) await queue(fixture, `slow${i}@example.net`);

    const loop = new SendLoop({ workerId: "worker-a", maxConcurrency: 10, pollIntervalMs: 60_000 });
    const claimed = await loop.tick();
    await loop.stop();

    expect(claimed).toBe(2);
  });

  it("stops claiming once the worker is at its overall concurrency", async () => {
    const fixture = await seedFixture({ concurrency: 10 });
    for (let i = 0; i < 4; i++) await queue(fixture, `person${i}@example.net`);

    const loop = new SendLoop({ workerId: "worker-a", maxConcurrency: 2, pollIntervalMs: 60_000 });
    const claimed = await loop.tick();
    await loop.stop();

    expect(claimed).toBe(2);
  });

  it("waits for an in-flight send to settle before stop() resolves", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    const id = await queue(fixture, "person@example.net");

    const gate = Promise.withResolvers<void>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      await gate.promise;
      return new Response(JSON.stringify({ id: 1, status: "queued" }), { status: 200 });
    };

    try {
      const loop = new SendLoop({ workerId: "worker-a", maxConcurrency: 10, pollIntervalMs: 60_000 });
      await loop.tick();
      const stopping = loop.stop();

      let settled = false;
      void stopping.then(() => {
        settled = true;
      });
      // A microtask flush is enough: the send's fetch is held, so stop() cannot have resolved.
      await Promise.resolve();
      expect(settled).toBe(false);

      gate.resolve();
      await stopping;
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect((await messageRow(id)).status).toBe("sent");
  });
});

describe("draining a backlog", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function sentCount(): Promise<number> {
    const rows = await db.select({ id: messages.id }).from(messages).where(eq(messages.status, "sent"));
    return rows.length;
  }

  async function countDueChecks(during: () => Promise<void>): Promise<number> {
    const spy = vi.spyOn(queueModule, "dueProviders");
    try {
      await during();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  it("claims again as sends finish instead of waiting for the next poll", async () => {
    const fixture = await seedFixture({ concurrency: 4 });
    for (let i = 0; i < 24; i++) await queue(fixture, `person${i}@example.net`);

    const loop = new SendLoop({ workerId: "worker-a", maxConcurrency: 4, pollIntervalMs: 60_000 });
    loop.start();
    const sent = await until(sentCount, (count) => count === 24, 10_000);
    await loop.stop();

    // One poll; before, each poll sent at most 4.
    expect(sent).toBe(24);
  });

  it("doesn't spin while the provider is backing off", async () => {
    const fixture = await seedFixture({ concurrency: 2 });
    for (let i = 0; i < 10; i++) await queue(fixture, `person${i}@example.net`);
    await db
      .update(providers)
      .set({ backoffUntil: new Date((await dbNow()).getTime() + 60_000) })
      .where(eq(providers.id, fixture.providerId));

    const loop = new SendLoop({ workerId: "worker-a", maxConcurrency: 4, pollIntervalMs: 60_000 });
    const checks = await countDueChecks(async () => {
      loop.start();
      await sleep(300);
      await loop.stop();
    });

    expect(checks).toBe(1);
    expect(await sentCount()).toBe(0);
  });

  it("stops claiming once a stalled domain has released everything it holds", async () => {
    const fixture = await seedFixture({ concurrency: 2 });
    for (let i = 0; i < 3; i++) await queue(fixture, `person${i}@example.net`);
    await db
      .update(domains)
      .set({ stalledAt: await dbNow(), stallReason: "bounce_rate" })
      .where(eq(domains.id, fixture.domainId));

    const loop = new SendLoop({ workerId: "worker-a", maxConcurrency: 4, pollIntervalMs: 60_000 });
    const spy = vi.spyOn(queueModule, "dueProviders");
    try {
      loop.start();
      await until(
        async () => {
          const due = await db
            .select({ id: messages.id })
            .from(messages)
            .where(and(eq(messages.status, "queued"), lte(messages.nextAttemptAt, await dbNow())));
          return due.length;
        },
        (count) => count === 0,
        5000,
      );
      await sleep(50);
      const settled = spy.mock.calls.length;
      await sleep(150);
      await loop.stop();

      expect(spy.mock.calls.length).toBe(settled);
      expect(settled).toBeLessThan(20);
    } finally {
      spy.mockRestore();
    }
    expect(await sentCount()).toBe(0);
  });
});

describe("test-mode keys", () => {
  it("routes a live-provider message to the mock provider when the key is test mode", async () => {
    const fixture = await seedFixture({ keyMode: "test", providerAdapter: "mailpace" });
    const id = await queue(fixture, "person@example.net");

    await claimAndDeliver();

    const message = await messageRow(id);
    expect(message.status).toBe("sent");
    expect(message.providerMessageId).toMatch(/^mock_/);
  });
});

describe("a pending move to another provider", () => {
  it("keeps sending on the current provider, never the target — this fails if the binding swaps eagerly", async () => {
    const org = await seedFixture();
    const target = await addProvider(org, { providerAdapter: "mock", name: "secondary" });

    const caller: DomainCaller = { organizationId: org.organizationId, domainIds: [], actor: userActor("u_test", "Test") };
    await moveDomain(caller, org.domainId, target.providerId);

    const id = await queue(org, "person@example.net");
    await claimAndDeliver();

    const message = await messageRow(id);
    expect(message.status).toBe("sent");
    expect(message.providerId).toBe(org.providerId);
    expect(message.providerId).not.toBe(target.providerId);

    const [domainRow] = await db.select().from(domains).where(eq(domains.id, org.domainId)).limit(1);
    expect(domainRow?.providerId).toBe(org.providerId);
    expect(domainRow?.pendingProviderId).toBe(target.providerId);
  });
});

describe("differential provider routing", () => {
  it("sends each domain-bound message through the provider that owns that domain, not the org's only provider", async () => {
    const org = await seedFixture();
    const mailpace = await addProvider(org, { providerAdapter: "mailpace", credentials: { serverToken: "t", organizationToken: "org" } });
    const mailpaceDomain = await addDomainKeyFor(org, mailpace.providerId, "mailpace.example.com");
    const mockDomain = await addDomainKeyFor(org, org.providerId, "mock.example.com");

    const fetchCaptured: Array<{ url: string; init: RequestInit | undefined }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCaptured.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 9001, status: "queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const mailpaceId = await acceptMessage(
        mailpaceDomain.key,
        { from: "Ada <ada@mailpace.example.com>", to: ["person@example.net"], subject: "Hello", html: "<p>Hi</p>" },
        null,
      ).then((result) => result.message.id);

      const mockId = await acceptMessage(
        mockDomain.key,
        { from: "Ada <ada@mock.example.com>", to: ["person@example.net"], subject: "Hello", html: "<p>Hi</p>" },
        null,
      ).then((result) => result.message.id);

      await claimAndDeliver();

      // The mock-bound message went through the mock provider.
      const mockMessage = await messageRow(mockId);
      expect(mockMessage.status).toBe("sent");
      expect(mockMessage.providerMessageId).toMatch(/^mock_/);
      const mockSendsForMock = mockSends().filter((entry) => entry.message.from.address === "ada@mock.example.com");
      expect(mockSendsForMock).toHaveLength(1);

      // The mailpace-bound message went through the mailpace provider (the fetch stub captured it).
      const mailpaceMessage = await messageRow(mailpaceId);
      expect(mailpaceMessage.status).toBe("sent");
      expect(mailpaceMessage.providerMessageId).toBe("9001");
      const mailpaceSends = fetchCaptured.filter((entry) => entry.url.includes("/send"));
      expect(mailpaceSends).toHaveLength(1);

      // The mock provider never reached the mailpace provider, and vice versa.
      const mockSendsForMailpace = mockSends().filter((entry) => entry.message.from.address === "ada@mailpace.example.com");
      expect(mockSendsForMailpace).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("provider health evidence", () => {
  afterEach(async () => {
    delete process.env.REDIS_URL;
    await closeRedis();
  });

  it("records a successful delivery as evidence the provider is reachable", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const fixture = await seedFixture();
    await queue(fixture, "person@example.net");

    await claimAndDeliver();

    const [health] = await listProviderHealth();
    expect(health?.ok).toBe(true);
    expect(health?.source).toBe("send");
  });

  it("never touches provider health for a message-specific permanent failure", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const fixture = await seedFixture();
    await queue(fixture, "bounce@example.net");

    await claimAndDeliver();

    const [health] = await listProviderHealth();
    expect(health?.ok).toBeNull();
    expect(health?.detail).toBe("Not checked yet.");
  });

  it("leaves a test-mode send out of provider health entirely", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const fixture = await seedFixture({ keyMode: "test" });
    await queue(fixture, "person@example.net");

    await claimAndDeliver();

    const [health] = await listProviderHealth();
    expect(health?.ok).toBeNull();
  });
});

describe("Feedback-ID", () => {
  it("carries the organization and transactional mail type on a plain send", async () => {
    const fixture = await seedFixture();
    await queue(fixture, "person@example.net");

    await claimAndDeliver();

    expect(mockSends()[0]?.message.headers["Feedback-ID"]).toBe(`${fixture.organizationId}:transactional:pouch`);
  });

  it("carries the bulk mail type for a message belonging to a batch", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "person@example.net");
    await db.update(messages).set({ batchId: "batch_test" }).where(eq(messages.id, id));

    await claimAndDeliver();

    expect(mockSends()[0]?.message.headers["Feedback-ID"]).toBe(`${fixture.organizationId}:bulk:pouch`);
  });

  it("never overwrites a caller-supplied Feedback-ID, case-insensitively", async () => {
    const fixture = await seedFixture();
    const { message } = await acceptMessage(
      fixture.key,
      { ...request("person@example.net"), headers: { "feedback-id": "caller:set:value" } },
      null,
    );

    await claimAndDeliver();

    expect(mockSends()[0]?.message.headers).toMatchObject({ "feedback-id": "caller:set:value" });
    expect(message.id).toBeTruthy();
  });

  it("skips the header for a provider that drops custom headers", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    await queue(fixture, "person@example.net");

    const [claimed] = await claimMessages({ workerId: "w1", providerId: fixture.providerId, limit: 10 });
    if (!claimed) throw new Error("expected a claimed message");
    const outbound = await toOutbound(claimed);

    expect(outbound.headers["Feedback-ID"]).toBeUndefined();
  });
});

describe("suppression at send time", () => {
  it("fails a queued message whose recipient was suppressed after it was accepted, without sending it", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "later-bounced@example.net");
    await addSuppression(fixture.organizationId, "later-bounced@EXAMPLE.net");

    await claimAndDeliver();

    const row = await messageRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.failureReason).toMatch(/^Recipient is suppressed: hard bounce on \d{4}-\d{2}-\d{2}\.$/);
    expect(row?.attempts).toBe(0);
    expect(mockSends()).toHaveLength(0);
  });

  it("still sends to a recipient nobody suppressed", async () => {
    const fixture = await seedFixture();
    const id = await queue(fixture, "fine@example.net");
    await addSuppression(fixture.organizationId, "someone-else@example.net");

    await claimAndDeliver();

    expect((await messageRow(id))?.status).toBe("sent");
  });
});
