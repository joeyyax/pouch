import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messageEvents, messageHourlyStats, messages, organizations } from "@/lib/db/schema";
import type { MessageStatus } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { selectShape } from "@/lib/api/shape";
import { statsShape } from "@/lib/schemas/stats";
import { readStats, type StatsResponse } from "@/lib/stats";
import { readRollupState, rollupMessageStats, ROLLUP_KEPT_DAYS } from "@/lib/stats/rollup";
import { queueDepth } from "@/lib/messages/queue-depth";
import { listMessages } from "@/lib/messages/list";
import { GET } from "@/app/api/v1/stats/route";
import { addDomainKey, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const NOW = new Date("2026-09-08T12:34:56.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const EVERYTHING = selectShape(statsShape, {
  include: ["previous_buckets", "latency", "domains", "keys", "reasons", "domain_days"],
});

let fixture: Fixture;
let second: Awaited<ReturnType<typeof addDomainKey>>;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
  second = await addDomainKey(fixture, "second.example.com");
});

async function send(options: {
  agoMs: number;
  status?: MessageStatus;
  domainId?: string;
  apiKeyId?: string | null;
  testMode?: boolean;
  queueMs?: number | null;
  providerMs?: number | null;
  attempts?: number;
  reason?: string;
}): Promise<string> {
  // A queued message is due from when it was accepted.
  const createdAt = new Date(NOW.getTime() - options.agoMs);
  const sentAt = options.queueMs === null ? null : new Date(createdAt.getTime() + (options.queueMs ?? 300));
  const deliveredAt = sentAt && options.providerMs !== null ? new Date(sentAt.getTime() + (options.providerMs ?? 1500)) : null;
  const id = await seedMessage(
    { organizationId: fixture.organizationId, domainId: options.domainId ?? fixture.domainId },
    {
      status: options.status ?? "delivered",
      createdAt,
      sentAt,
      deliveredAt: options.status === undefined || options.status === "delivered" ? deliveredAt : null,
      apiKeyId: options.apiKeyId === undefined ? fixture.key.id : options.apiKeyId,
      testMode: options.testMode ?? false,
      attempts: options.attempts ?? 1,
      nextAttemptAt: createdAt,
    },
  );
  if (options.reason) {
    await db.insert(messageEvents).values({
      id: newId("event"),
      organizationId: fixture.organizationId,
      messageId: id,
      status: options.status ?? "bounced",
      reason: options.reason,
      occurredAt: new Date(createdAt.getTime() + HOUR),
    });
  }
  return id;
}

/** Five weeks of mail across two domains, two keys and both modes, with the last day busy. */
async function seedHistory(): Promise<void> {
  for (let day = 0; day < 35; day += 1) {
    const base = day * DAY + 7 * MINUTE;
    await send({ agoMs: base, queueMs: 200 + day * 10, providerMs: 1000 + day * 100 });
    await send({ agoMs: base + 3 * HOUR, domainId: second.domainId, apiKeyId: second.key.id, queueMs: 4000, providerMs: 30_000 });
    if (day % 3 === 0) await send({ agoMs: base + 5 * HOUR, status: "bounced", providerMs: null, reason: "550 5.1.1 user unknown", attempts: 2 });
    if (day % 5 === 0) await send({ agoMs: base + 6 * HOUR, status: "complained", providerMs: null, reason: "abuse" });
    if (day % 4 === 0) await send({ agoMs: base + 2 * HOUR, testMode: true, status: "bounced", providerMs: null, reason: "test bounce" });
    if (day % 7 === 0) await send({ agoMs: base + 9 * HOUR, status: "sent", providerMs: null, apiKeyId: null });
  }
  await send({ agoMs: 20 * MINUTE, status: "queued", queueMs: null });
  await send({ agoMs: 2 * HOUR, status: "deferred", providerMs: null, attempts: 3 });
}

function read(query: Parameters<typeof readStats>[1], at = NOW) {
  return readStats({ organizationId: fixture.organizationId, domainIds: [] }, query, EVERYTHING, at) as Promise<StatsResponse>;
}

describe("the rollup", () => {
  it("answers with the numbers a live count gives", async () => {
    await seedHistory();
    const windows = [{ window: "24h" as const }, { window: "7d" as const }, { window: "30d" as const, bucket: "hour" as const }, { window: "90d" as const }];
    const live = await Promise.all(windows.map((query) => read(query)));

    await rollupMessageStats(NOW);
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(messageHourlyStats);
    expect(row?.count).toBeGreaterThan(70);
    const rolled = await Promise.all(windows.map((query) => read(query)));

    expect(rolled).toEqual(live);
    expect(live[2]!.counts.total).toBeGreaterThan(60);
    expect(live[2]!.reasons.map((row) => row.reason)).toEqual(["550 5.1.1 user unknown", "abuse"]);
  });

  it("counts the live day from messages, not from the last run", async () => {
    await rollupMessageStats(NOW);
    await send({ agoMs: 30 * MINUTE });

    expect((await read({ window: "24h" })).counts.total).toBe(1);
  });

  it("redoes an hour once a message in it changes", async () => {
    const id = await send({ agoMs: 5 * DAY, status: "sent", providerMs: null });
    await rollupMessageStats(NOW);
    await db
      .update(messages)
      .set({ status: "bounced", updatedAt: new Date(NOW.getTime() + 10 * MINUTE) })
      .where(eq(messages.id, id));

    const stale = await read({ window: "7d" }, new Date(NOW.getTime() + 20 * MINUTE));
    expect(stale.counts.bounced).toBe(0);

    await rollupMessageStats(new Date(NOW.getTime() + HOUR));
    const fresh = await read({ window: "7d" }, new Date(NOW.getTime() + HOUR));
    expect(fresh.counts).toMatchObject({ bounced: 1, sent: 0 });
  });

  it("reads live past the hour the last run reached", async () => {
    await rollupMessageStats(new Date(NOW.getTime() - 3 * DAY));
    await send({ agoMs: 2 * DAY });

    expect((await read({ window: "7d" })).counts.total).toBe(1);
  });

  it("drops hours past what it keeps", async () => {
    await send({ agoMs: (ROLLUP_KEPT_DAYS + 2) * DAY });
    await send({ agoMs: 3 * DAY });
    await rollupMessageStats(NOW);

    const hours = await db.select({ hour: messageHourlyStats.hour }).from(messageHourlyStats);
    expect(hours).toHaveLength(1);
    expect((await readRollupState())?.coveredFrom.getTime()).toBeGreaterThan(NOW.getTime() - ROLLUP_KEPT_DAYS * DAY - HOUR);
  });

  it("goes with the domain it counted", async () => {
    await send({ agoMs: 3 * DAY, domainId: second.domainId, apiKeyId: second.key.id });
    await rollupMessageStats(NOW);
    await db.delete(messages).where(eq(messages.domainId, second.domainId));
    await db.delete(domains).where(eq(domains.id, second.domainId));

    expect(await db.select().from(messageHourlyStats)).toHaveLength(0);
  });
});

describe("a stats read", () => {
  it("leaves test mode out unless asked", async () => {
    await send({ agoMs: DAY });
    await send({ agoMs: DAY, testMode: true });

    expect((await read({ window: "7d" })).counts.total).toBe(1);
    expect((await read({ window: "7d", mode: "test" })).counts.total).toBe(1);
    expect((await read({ window: "7d", mode: "all" })).counts.total).toBe(2);
  });

  it("narrows to a domain, a key and statuses", async () => {
    await send({ agoMs: DAY });
    await send({ agoMs: DAY, status: "bounced", providerMs: null });
    await send({ agoMs: DAY, domainId: second.domainId, apiKeyId: second.key.id });

    expect((await read({ window: "7d", domain: second.domainId })).counts.total).toBe(1);
    expect((await read({ window: "7d", key: fixture.key.id })).counts.total).toBe(2);
    const bounced = await read({ window: "7d", status: ["bounced"] });
    expect(bounced.counts).toMatchObject({ total: 1, bounced: 1, delivered: 0 });
  });

  it("lines the previous window up with this one", async () => {
    await send({ agoMs: 2 * DAY });
    await send({ agoMs: 9 * DAY, status: "bounced", providerMs: null });

    const stats = await read({ window: "7d" });
    expect(stats.previous_buckets).toHaveLength(stats.buckets.length);
    expect(stats.previous_buckets.findIndex((bucket) => bucket.bounced > 0)).toBe(stats.buckets.findIndex((bucket) => bucket.delivered > 0));
    expect(stats.previous_counts.total).toBe(1);
  });

  it("keeps a domain that sent last window and nothing this one", async () => {
    await send({ agoMs: 10 * DAY, domainId: second.domainId, apiKeyId: second.key.id });

    const [row] = (await read({ window: "7d" })).domains;
    expect(row).toMatchObject({ domain_id: second.domainId, name: "second.example.com", previous_total: 1, counts: { total: 0 } });
    expect(row?.last_sent_at).not.toBeNull();
  });
});

describe("the queue", () => {
  it("is one definition: held here is what the held filter lists", async () => {
    await send({ agoMs: 10 * MINUTE, status: "queued", queueMs: null });
    await send({ agoMs: 20 * MINUTE, status: "queued", queueMs: null, domainId: second.domainId, apiKeyId: second.key.id });
    await db.update(domains).set({ stalledAt: NOW, stallReason: "bounce_rate" }).where(eq(domains.id, second.domainId));

    const queue = await queueDepth({ organizationId: fixture.organizationId, domainIds: [], mode: "all" }, NOW);
    const held = await listMessages({ organizationId: fixture.organizationId, domainIds: [] }, 50, undefined, { held: true });
    expect(queue).toMatchObject({ queued: 2, held: 1, due: 1 });
    expect(held.data).toHaveLength(queue.held);
    expect(queue.held_by_domain).toEqual([{ domain_id: second.domainId, count: 1, oldest_queued_at: expect.any(Date) }]);
  });

  it("holds everything under a suspension that holds the queue", async () => {
    await send({ agoMs: 10 * MINUTE, status: "queued", queueMs: null });
    await db
      .update(organizations)
      .set({ suspendedAt: NOW, suspendSource: "reputation", suspendReason: "Too many bounces." })
      .where(eq(organizations.id, fixture.organizationId));

    const queue = await queueDepth({ organizationId: fixture.organizationId, domainIds: [], mode: "all" }, NOW);
    expect(queue).toMatchObject({ held: 1, due: 0, organization_held: true, held_by_domain: [] });
  });
});

describe("GET /v1/stats", () => {
  function get(secret: string, query = ""): Promise<Response> {
    return GET(new Request(`http://localhost/v1/stats${query}`, { headers: { authorization: `Bearer ${secret}` } }));
  }

  it("returns the window, counts against the previous one and buckets", async () => {
    await seedMessage(fixture, { createdAt: new Date(Date.now() - DAY) });

    const response = await get(fixture.secret, "?window=7d");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(Object.keys(body)).toEqual(["window", "mode", "counts", "previous_counts", "attempts", "buckets"]);
    expect(body.window.bucket).toBe("day");
    expect(body.counts.total).toBe(1);
    expect(body.buckets).toHaveLength(8);
  });

  it("trims to fields and grows by include", async () => {
    const body = await (await get(fixture.secret, "?fields=counts&include=latency,queue")).json();
    expect(Object.keys(body)).toEqual(["window", "counts", "latency", "queue"]);
    expect(body.queue.queued).toBe(0);
  });

  it("names what it doesn't know", async () => {
    const response = await get(fixture.secret, "?include=everything");
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({ code: "validation_failed", field: "include" });
    expect((await get(fixture.secret, "?window=7d&since=2026-09-01T00:00:00Z")).status).toBe(422);
  });

  it("keeps a scoped key to its domains", async () => {
    await seedMessage(fixture, { createdAt: new Date(Date.now() - HOUR) });
    await seedMessage({ organizationId: fixture.organizationId, domainId: second.domainId }, { createdAt: new Date(Date.now() - HOUR) });

    expect((await (await get(second.secret, "?window=24h")).json()).counts.total).toBe(1);
    const refused = await get(second.secret, `?domain=${fixture.domainId}`);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("key_not_scoped");
  });

  it("gives a test key test mail only", async () => {
    const test = await seedFixture({ keyMode: "test", scopeToDomain: false });
    await seedMessage(test, { createdAt: new Date(Date.now() - HOUR), testMode: true });
    await seedMessage(test, { createdAt: new Date(Date.now() - HOUR) });

    const body = await (await get(test.secret, "?window=24h")).json();
    expect(body).toMatchObject({ mode: "test", counts: { total: 1 } });
    expect((await get(test.secret, "?mode=live")).status).toBe(403);
    expect((await get(test.secret, "?include=inbound")).status).toBe(403);
  });
});
