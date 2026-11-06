import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, jobHeartbeats, messages, organizations, providers } from "@/lib/db/schema";
import * as providersModule from "@/lib/providers";
import * as queueModule from "@/lib/messages/queue";
import { encryptCredentials, listProviders, readProvider, type ProviderRow } from "@/lib/providers";
import { userActor } from "@/lib/activity/record";
import { readSendingProvider } from "@/lib/dashboard/service";
import { acquireSendPermits, refundSendPermits, sendRateSubject, setSendRate } from "@/lib/providers/send-rate";
import { PROVIDER_CHECK_TTL_SECONDS, TENANT_CHECK_TTL_SECONDS } from "@/lib/health/checks";
import { newId } from "@/lib/ids";
import { acceptMessage } from "@/lib/messages/create";
import { claimMessages, dueProviders } from "@/lib/messages/queue";
import { resetMockSends } from "@/lib/providers/adapters/mock";
import { closeRedis, redis } from "@/lib/redis";
import { ProviderHealthLoop } from "@/worker/health-check";
import { SendLoop } from "@/worker/loop";
import { deliver } from "@/worker/send";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";
import { clearRedisKeys, testRedisUrl } from "../redis";

const REDIS_URL = testRedisUrl();

let sharedId: string;

async function addSharedProvider(): Promise<string> {
  const id = newId("provider");
  await db.insert(providers).values({
    id,
    adapter: "mock",
    name: "Hosted",
    credentials: encryptCredentials({ serverToken: "shared" }),
    shared: true,
  });
  return id;
}

/** An organization whose provider is a tenant of the shared provider. */
async function tenant(): Promise<Fixture> {
  const fixture = await seedFixture();
  await db
    .update(providers)
    .set({ sharedProviderId: sharedId, settings: { tenantName: `tenant-${fixture.organizationId}` } })
    .where(eq(providers.id, fixture.providerId));
  return fixture;
}

async function queue(fixture: Fixture, to: string): Promise<string> {
  const { message } = await acceptMessage(fixture.key, { from: "Ada <ada@example.com>", to: [to], subject: "Hi", html: "<p>Hi</p>" }, null);
  return message.id;
}

async function provider(id: string): Promise<ProviderRow> {
  const [row] = await db.select().from(providers).where(eq(providers.id, id));
  return row!;
}

async function deliverFor(fixture: Fixture, workerId = "worker-test"): Promise<number> {
  const claimed = await claimMessages({ workerId, providerId: fixture.providerId, limit: 10 });
  for (const item of claimed) await deliver(item);
  return claimed.length;
}

beforeEach(async () => {
  await resetDatabase();
  resetMockSends();
  sharedId = await addSharedProvider();
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (process.env.REDIS_URL) await clearRedisKeys("send-rate:", "health:tenant-");
  delete process.env.REDIS_URL;
  await closeRedis();
});

describe("provider-wide backoff", () => {
  it("holds org B's sends when org A's tenant is throttled", async () => {
    const orgA = await tenant();
    const orgB = await tenant();
    await queue(orgA, "slow@example.net");
    const waiting = await queue(orgB, "person@example.net");

    expect(await deliverFor(orgA)).toBe(1);

    expect((await dueProviders()).map((due) => due.id)).not.toContain(orgB.providerId);
    expect(await deliverFor(orgB)).toBe(0);
    const [message] = await db.select().from(messages).where(eq(messages.id, waiting));
    expect(message?.status).toBe("queued");

    const shared = await provider(sharedId);
    expect(shared.backoffUntil!.getTime()).toBeGreaterThan((await dbNow()).getTime());
    expect(shared.backingOffSince).not.toBeNull();
  });

  it("releases every tenant once the shared backoff passes", async () => {
    const orgA = await tenant();
    const orgB = await tenant();
    await queue(orgA, "slow@example.net");
    await queue(orgB, "person@example.net");
    await deliverFor(orgA);

    await db.update(providers).set({ backoffUntil: new Date((await dbNow()).getTime() - 1000) }).where(eq(providers.id, sharedId));

    expect(await deliverFor(orgB)).toBe(1);
    expect((await provider(sharedId)).backingOffSince).toBeNull();
  });

  it("keeps a backoff the provider scopes to one tenant on that tenant", async () => {
    const orgA = await tenant();
    const orgB = await tenant();
    await queue(orgA, "person@example.net");
    await queue(orgB, "person@example.net");
    const real = providersModule.adapterFor;
    vi.spyOn(providersModule, "adapterFor").mockImplementation((row) => ({
      ...real(row),
      send: async () => ({ successful: false, errors: ["Sending paused"], failure: "backoff", retryAfterSeconds: 900 }),
    }));

    await deliverFor(orgA);

    expect((await provider(orgA.providerId)).backoffUntil).not.toBeNull();
    expect((await provider(sharedId)).backoffUntil).toBeNull();
    expect((await dueProviders()).map((due) => due.id)).toContain(orgB.providerId);
  });

  it("never shortens a longer backoff already on the shared provider", async () => {
    const orgA = await tenant();
    await queue(orgA, "slow@example.net");
    const now = await dbNow();
    const longer = new Date(now.getTime() + 15 * 60_000);
    const since = new Date(now.getTime() - 60_000);
    await db.update(providers).set({ backoffUntil: longer, backingOffSince: since }).where(eq(providers.id, sharedId));
    const [claimed] = await claimMessages({ workerId: "w", providerId: orgA.providerId, limit: 1 });
    expect(claimed).toBeUndefined();

    // The tenant's message was claimed before the shared backoff landed.
    await db.update(providers).set({ backoffUntil: null }).where(eq(providers.id, sharedId));
    const [item] = await claimMessages({ workerId: "w", providerId: orgA.providerId, limit: 1 });
    await db.update(providers).set({ backoffUntil: longer }).where(eq(providers.id, sharedId));
    await deliver(item!);

    const shared = await provider(sharedId);
    expect(shared.backoffUntil?.getTime()).toBe(longer.getTime());
    expect(shared.backingOffSince?.getTime()).toBe(since.getTime());
  });

  it("shows a tenant the shared provider's backoff through the API", async () => {
    const orgA = await tenant();
    const until = new Date((await dbNow()).getTime() + 60_000);
    await db.update(providers).set({ backoffUntil: until }).where(eq(providers.id, sharedId));
    const caller = { organizationId: orgA.organizationId, domainIds: [], actor: userActor("u_1", "Ada") };

    const read = await readProvider(caller, orgA.providerId);
    const { data } = await listProviders(caller, 10);

    expect(read.backoff_until).toBe(until.toISOString());
    expect(data.find((row) => row.id === orgA.providerId)?.backoff_until).toBe(until.toISOString());
  });

  it("shows a tenant the shared provider's backoff on the dashboard", async () => {
    const orgA = await tenant();
    const until = new Date((await dbNow()).getTime() + 60_000);
    await db.update(providers).set({ backoffUntil: until }).where(eq(providers.id, sharedId));

    await db.update(organizations).set({ providerId: orgA.providerId }).where(eq(organizations.id, orgA.organizationId));

    const sending = await readSendingProvider(orgA.organizationId);

    expect(sending?.status).toBe("paused");
    expect(sending?.backoffUntil?.getTime()).toBe(until.getTime());
  });

  it("keeps an ordinary provider's throttle to itself", async () => {
    const orgA = await seedFixture();
    const orgB = await seedFixture();
    await queue(orgA, "slow@example.net");
    await queue(orgB, "person@example.net");

    await deliverFor(orgA);

    expect((await provider(orgA.providerId)).backoffUntil).not.toBeNull();
    expect(await deliverFor(orgB)).toBe(1);
  });
});

describe("shared send rate", () => {
  it("grants a burst, then nothing until tokens refill, and takes refunds back", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await setSendRate(sharedId, 40);

    // 40/s at 80% headroom is 32/s; a 125ms burst is 4.
    const first = await acquireSendPermits(sharedId, 20);
    expect(first.granted).toBe(4);
    expect(first.retryInMs).toBeGreaterThan(0);
    expect(first.retryInMs).toBeLessThanOrEqual(32);
    // One token refills every ~31ms.
    expect((await acquireSendPermits(sharedId, 20)).granted).toBeLessThanOrEqual(1);
    await acquireSendPermits(sharedId, 20);
    await refundSendPermits(sharedId, 3);
    expect((await acquireSendPermits(sharedId, 20)).granted).toBeGreaterThanOrEqual(3);
  });

  it("doesn't limit a provider with no known rate", async () => {
    process.env.REDIS_URL = REDIS_URL;

    expect(await acquireSendPermits(sharedId, 50)).toEqual({ granted: 50, retryInMs: 0 });
  });

  it("caps the send loop's claims across tenants and leaves ordinary providers alone", async () => {
    process.env.REDIS_URL = REDIS_URL;
    // One permit, and the next 12.5s out, so a slow round can't refill the bucket between tenants.
    await setSendRate(sharedId, 0.1);
    const orgA = await tenant();
    const orgB = await tenant();
    const ordinary = await seedFixture();
    for (const fixture of [orgA, orgB, ordinary]) {
      for (let i = 0; i < 3; i++) await queue(fixture, "person@example.net");
    }

    const loop = new SendLoop({ workerId: "worker-rate", maxConcurrency: 20, pollIntervalMs: 60_000 });
    await loop.tick();
    await loop.stop();

    const sent = await db
      .select({ domainId: messages.domainId })
      .from(messages)
      .where(eq(messages.status, "sent"));
    const byDomain = (fixture: Fixture) => sent.filter((row) => row.domainId === fixture.domainId).length;
    expect(byDomain(orgA) + byDomain(orgB)).toBe(1);
    expect(byDomain(ordinary)).toBe(3);
  });
});

describe("draining against the shared rate", () => {
  it("writes no job heartbeat once stop() has resolved", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const fixture = await tenant();
    await queue(fixture, "person@example.net");

    const loop = new SendLoop({ workerId: "worker-stopped", maxConcurrency: 4, pollIntervalMs: 60_000 });
    loop.start();
    await loop.stop();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const beat = async () => (await db.select().from(jobHeartbeats).where(eq(jobHeartbeats.name, "send")))[0]?.lastBeatAt.getTime();
    const settled = await beat();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(settled).toBeDefined();
    expect(await beat()).toBe(settled);
  });

  it("drains past one burst on its own without spinning while rate-limited", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await setSendRate(sharedId, 8);
    const fixture = await tenant();
    for (let i = 0; i < 40; i++) await queue(fixture, "person@example.net");

    const spy = vi.spyOn(queueModule, "dueProviders");
    const loop = new SendLoop({ workerId: "worker-rate", maxConcurrency: 20, pollIntervalMs: 60_000 });
    let checks: number;
    try {
      loop.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await loop.stop();
      checks = spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }

    const sent = await db.select({ id: messages.id }).from(messages).where(eq(messages.status, "sent"));
    // 8/s at 80% headroom is 6.4/s.
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.length).toBeLessThanOrEqual(10);
    expect(checks).toBeLessThan(sent.length + 10);
  });
});

describe("an ordinary provider's send rate", () => {
  /** The most attempts that started inside any one-second window. */
  async function busiestSecond(): Promise<{ sent: number; peak: number }> {
    const rows = await db.select({ at: messages.lastAttemptAt }).from(messages).where(eq(messages.status, "sent"));
    const times = rows.map((row) => row.at!.getTime()).sort((a, b) => a - b);
    let peak = 0;
    for (let start = 0, end = 0; end < times.length; end++) {
      while (times[end]! - times[start]! >= 1000) start++;
      peak = Math.max(peak, end - start + 1);
    }
    return { sent: times.length, peak };
  }

  async function ordinary(identity: string, concurrency = 8): Promise<Fixture> {
    const fixture = await seedFixture({ concurrency });
    await db.update(providers).set({ providerIdentity: identity }).where(eq(providers.id, fixture.providerId));
    return fixture;
  }

  /** Runs the loop until every row has sent, or the bound passes. */
  async function drain(total: number, timeoutMs = 20_000): Promise<void> {
    const loop = new SendLoop({ workerId: "worker-rate", maxConcurrency: 16, pollIntervalMs: 60_000 });
    loop.start();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && (await busiestSecond()).sent < total) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await loop.stop();
  }

  it("drains everything, never starting more than MaxSendRate sends in a second, across rows sharing a provider identity", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await setSendRate(sendRateSubject({ id: "", adapter: "mock", providerIdentity: "111122223333", sharedProviderId: null }), 14);
    const first = await ordinary("111122223333", 4);
    const second = await ordinary("111122223333", 4);
    for (let i = 0; i < 20; i++) {
      await queue(first, `a${i}@example.net`);
      await queue(second, `b${i}@example.net`);
    }

    await drain(40);

    const { sent, peak } = await busiestSecond();
    expect(sent).toBe(40);
    expect(peak).toBeLessThanOrEqual(14);
  });
});

describe("tenant health checks", () => {
  function recordProbes(): string[] {
    const probed: string[] = [];
    const real = providersModule.adapterFor;
    vi.spyOn(providersModule, "adapterFor").mockImplementation((row) => {
      const provider = real(row);
      return {
        ...provider,
        healthCheck: async () => {
          probed.push(row.id);
          return provider.healthCheck();
        },
        ...(row.shared ? { quota: async () => ({ maxSendRate: 14, max24HourSend: 50_000, sentLast24Hours: 4, enforcementStatus: "HEALTHY" }) } : {}),
      };
    });
    return probed;
  }

  it("probes a rotating sample of tenants and wraps at the end", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const tenants = [await tenant(), await tenant(), await tenant()].map((fixture) => fixture.providerId).sort();
    const probed = recordProbes();

    const loop = new ProviderHealthLoop({ intervalMs: 60_000, probeSpacingMs: 0, tenantProbesPerPass: 2 });
    await loop.tick();
    await redis()!.del(`health:tenant-sweep:${sharedId}`);
    await loop.tick();

    const tenantProbes = probed.filter((id) => tenants.includes(id));
    expect(tenantProbes).toEqual([tenants[0], tenants[1], tenants[2], tenants[0]]);
    expect(probed.filter((id) => id === sharedId)).toHaveLength(2);
  });

  it("skips a tenant the provider hasn't created yet", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const withDomain = await tenant();
    const created = await tenant();
    await db.delete(domains).where(eq(domains.organizationId, created.organizationId));
    await db
      .update(providers)
      .set({ settings: { tenantName: `tenant-${created.organizationId}`, tenantArn: "arn:aws:ses:us-west-2:111122223333:tenant/x/tn-1" } })
      .where(eq(providers.id, created.providerId));
    const empty = await tenant();
    await db.delete(domains).where(eq(domains.organizationId, empty.organizationId));
    const probed = recordProbes();

    await new ProviderHealthLoop({ intervalMs: 60_000, probeSpacingMs: 0 }).tick();

    expect(probed).toContain(withDomain.providerId);
    expect(probed).toContain(created.providerId);
    expect(probed).not.toContain(empty.providerId);
  });

  it("gives a shared provider's tenants the identity it learns", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const orgA = await tenant();
    const real = providersModule.adapterFor;
    vi.spyOn(providersModule, "adapterFor").mockImplementation((row) => ({ ...real(row), identity: async () => "121212121212" }));

    await new ProviderHealthLoop({ intervalMs: 60_000, probeSpacingMs: 0, tenantProbesPerPass: 0 }).tick();

    expect((await provider(sharedId)).providerIdentity).toBe("121212121212");
    expect((await provider(orgA.providerId)).providerIdentity).toBe("121212121212");
  });

  it("lets only one replica sweep a shared provider per interval", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await tenant();
    const probed = recordProbes();

    await new ProviderHealthLoop({ workerId: "a", intervalMs: 60_000, probeSpacingMs: 0 }).tick();
    await new ProviderHealthLoop({ workerId: "b", intervalMs: 60_000, probeSpacingMs: 0 }).tick();

    expect(probed.filter((id) => id === sharedId)).toHaveLength(1);
  });

  it("keeps a tenant's verdict past a full rotation and stores the shared send rate", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const orgA = await tenant();
    const ordinary = await seedFixture();
    recordProbes();

    await new ProviderHealthLoop({ intervalMs: 60_000, probeSpacingMs: 0 }).tick();

    const client = redis()!;
    expect(await client.ttl(`health:provider:${orgA.providerId}`)).toBeGreaterThan(TENANT_CHECK_TTL_SECONDS - 60);
    const ordinaryTtl = await client.ttl(`health:provider:${ordinary.providerId}`);
    expect(ordinaryTtl).toBeGreaterThan(0);
    expect(ordinaryTtl).toBeLessThanOrEqual(PROVIDER_CHECK_TTL_SECONDS);
    expect(await client.get(`send-rate:limit:${sharedId}`)).toBe("14");
  });

  it("stores an ordinary provider's send rate under its provider identity", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const ordinary = await seedFixture();
    await db.update(providers).set({ providerIdentity: "777788889999" }).where(eq(providers.id, ordinary.providerId));
    const real = providersModule.adapterFor;
    vi.spyOn(providersModule, "adapterFor").mockImplementation((row) => ({
      ...real(row),
      quota: async () => ({ maxSendRate: 14, max24HourSend: 50_000, sentLast24Hours: 4, enforcementStatus: "HEALTHY" }),
    }));

    await new ProviderHealthLoop({ intervalMs: 60_000, probeSpacingMs: 0 }).tick();

    const subject = sendRateSubject(await provider(ordinary.providerId));
    expect(subject).not.toBe(ordinary.providerId);
    expect((await acquireSendPermits(subject, 50)).granted).toBeLessThan(50);
  });

  it("never probes two rows of one provider at once, but runs different providers together", async () => {
    const first = await seedFixture();
    const second = await seedFixture();
    const other = await seedFixture();
    await db
      .update(providers)
      .set({ providerIdentity: "aws-1" })
      .where(inArray(providers.id, [first.providerId, second.providerId]));
    await db.update(providers).set({ providerIdentity: "aws-2" }).where(eq(providers.id, other.providerId));

    const active = new Map<string, number>();
    let peakSame = 0;
    let peakAll = 0;
    const real = providersModule.adapterFor;
    vi.spyOn(providersModule, "adapterFor").mockImplementation((row) => ({
      ...real(row),
      healthCheck: async () => {
        const key = row.providerIdentity ?? row.id;
        active.set(key, (active.get(key) ?? 0) + 1);
        peakSame = Math.max(peakSame, active.get(key)!);
        peakAll = Math.max(peakAll, [...active.values()].reduce((sum, n) => sum + n, 0));
        await new Promise((resolve) => setTimeout(resolve, 30));
        active.set(key, active.get(key)! - 1);
        return { ok: true, detail: null };
      },
    }));

    const checked = await new ProviderHealthLoop({ intervalMs: 60_000, probeSpacingMs: 0 }).tick();

    // Three fixtures and the shared provider.
    expect(checked).toBe(4);
    expect(peakSame).toBe(1);
    expect(peakAll).toBeGreaterThan(1);
  });
});
