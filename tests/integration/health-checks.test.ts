import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import * as dbModule from "@/lib/db";
import { jobHeartbeats, messages, providers } from "@/lib/db/schema";
import { closeRedis, redis } from "@/lib/redis";
import { closeStorage } from "@/lib/storage";
import { setStoredSetting } from "@/lib/settings/service";
import {
  checkPostgres,
  checkQueue,
  checkRedis,
  checkStorage,
  listProviderHealth,
  recordProviderProbe,
  recordProviderSendOutcome,
  SEND_FAILURE_THRESHOLD,
} from "@/lib/health/checks";
import * as healthChecks from "@/lib/health/checks";
import { readiness, READINESS_DEADLINE_MS } from "@/lib/health/readyz";
import { HEARTBEAT_KEY_PREFIX, HEARTBEAT_TTL_SECONDS, JOB_ERROR, LOOP_NAMES, readHeartbeats, recordHeartbeat, recordJobFinish, recordJobStart } from "@/lib/health";
import * as healthModule from "@/lib/health";
import * as lifecycleModule from "@/lib/storage/lifecycle";
import { GET as healthz } from "@/app/healthz/route";
import { acceptMessage } from "@/lib/messages/create";
import { probeProvider } from "@/lib/providers/admin";
import * as providersModule from "@/lib/providers";
import { ProviderHealthLoop } from "@/worker/health-check";
import type { SendEmailRequest } from "@/lib/schemas/email";
import { addProvider, resetDatabase, seedFixture, seedSystemOrganization, systemMailMessages, type Fixture } from "./fixtures";
import { clearRedisKeys, testRedisUrl } from "../redis";

const REDIS_URL = testRedisUrl();
const STORAGE_ENDPOINT = process.env.STORAGE_ENDPOINT ?? "http://localhost:9010";

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  // The local bucket has no lifecycle rule; body-lifecycle.test.ts covers that check.
  vi.spyOn(lifecycleModule, "readBodyLifecycle").mockResolvedValue({ state: "rule", days: 731 });
});

afterEach(async () => {
  delete process.env.REDIS_URL;
  await closeRedis();
});

afterAll(() => {
  delete process.env.REDIS_URL;
  process.env.STORAGE_ENDPOINT = STORAGE_ENDPOINT;
});

/** Every loop has finished a clean run, so the jobs check has nothing to report. */
async function everyJobRan(): Promise<void> {
  for (const name of LOOP_NAMES) {
    await recordJobStart(name, 60_000, "worker-1");
    await recordJobFinish(name, null);
  }
}

async function queue(f: Fixture, to = "person@example.net"): Promise<void> {
  const request: SendEmailRequest = { from: "Ada <ada@example.com>", to: [to], subject: "Hi", html: "<p>Hi</p>" };
  await acceptMessage(f.key, request, null);
}

/** Clears every worker's heartbeat, not just one key — there's no longer a single key to delete. */
async function clearHeartbeats(): Promise<void> {
  await clearRedisKeys(HEARTBEAT_KEY_PREFIX);
}

describe("checkPostgres", () => {
  it("is ok against a reachable database", async () => {
    expect(await checkPostgres()).toEqual({ ok: true, detail: null });
  });
});

describe("checkRedis", () => {
  it("reports unset rather than down when REDIS_URL is missing", async () => {
    expect(await checkRedis()).toEqual({ ok: false, detail: "REDIS_URL isn't set." });
  });

  it("is ok against a reachable Redis", async () => {
    process.env.REDIS_URL = REDIS_URL;
    expect(await checkRedis()).toEqual({ ok: true, detail: null });
  });

  it("reports a broken URL as down rather than hanging", async () => {
    process.env.REDIS_URL = "redis://localhost:1";
    const result = await checkRedis(300);
    expect(result.ok).toBe(false);
    await closeRedis();
  });
});

describe("checkStorage", () => {
  it("is ok against the real bucket", async () => {
    expect(await checkStorage()).toEqual({ ok: true, detail: null });
  });

  it("reports a dead endpoint as unreachable rather than hanging", async () => {
    await closeStorage();
    process.env.STORAGE_ENDPOINT = "http://localhost:1";

    const result = await checkStorage(300);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("Storage endpoint unreachable.");

    await closeStorage();
    process.env.STORAGE_ENDPOINT = STORAGE_ENDPOINT;
  });
});

describe("checkQueue", () => {
  it("reports an empty queue as ok with no oldest timestamp", async () => {
    expect(await checkQueue()).toEqual({ ok: true, detail: null, depth: 0, oldestQueuedAt: null });
  });

  it("counts what's queued and names the oldest", async () => {
    await queue(fixture, "one@example.net");
    await queue(fixture, "two@example.net");

    const result = await checkQueue();
    expect(result.ok).toBe(true);
    expect(result.depth).toBe(2);
    expect(result.oldestQueuedAt).not.toBeNull();
  });

  it("flags a queue that stopped draining, not merely a busy one", async () => {
    await queue(fixture);
    await db.update(messages).set({ createdAt: sql`now() - interval '1 hour'` }).where(sql`true`);

    const result = await checkQueue();
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("Queue isn't moving.");
  });
});

describe("provider health tracking", () => {
  it("says unchecked, not down, before anything has probed the provider", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const [health] = await listProviderHealth();
    expect(health?.ok).toBeNull();
    expect(health?.detail).toBe("Not checked yet.");
  });

  it.each([
    ["a probe's verdict immediately", null, "ses", { ok: false, detail: "Credentials were rejected." }],
    ["a probe that can't check itself as null, not unchecked", null, "mailpace", { ok: null, detail: "no organization token" }],
    ["null over a prior verdict when a provider goes from checkable to unchecked", { ok: true, detail: null }, "ses", { ok: null, detail: "no organization token" }],
  ] as const)("records %s", async (_name, prior, adapter, probe) => {
    process.env.REDIS_URL = REDIS_URL;
    if (prior) await recordProviderProbe(fixture.providerId, adapter, prior);
    await recordProviderProbe(fixture.providerId, adapter, probe);

    const [health] = await listProviderHealth();
    expect(health?.ok).toBe(probe.ok);
    expect(health?.detail).toBe(probe.detail);
    expect(health?.source).toBe("probe");
  });

  it("records what a manual test found, so the screen doesn't say unchecked right after a check", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const [provider] = await db.select().from(providers).where(eq(providers.id, fixture.providerId)).limit(1);

    const result = await probeProvider(provider!);

    const [health] = await listProviderHealth();
    expect(health?.ok).toBe(result.ok);
    expect(health?.checkedAt).not.toBeNull();
    expect(health?.source).toBe("probe");
  });

  it("stays null through a sub-threshold send failure, rather than defaulting to ok", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const provider = fixture.providerId;
    await recordProviderProbe(provider, "mailpace", { ok: null, detail: "no organization token" });

    await recordProviderSendOutcome(provider, "mailpace", { successful: false, errors: ["x"], failure: "transient" });

    const [health] = await listProviderHealth();
    expect(health?.ok).toBeNull();
  });

  it("doesn't flip to down on one failed send, only on a run of them", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const provider = fixture.providerId;

    for (let i = 0; i < SEND_FAILURE_THRESHOLD - 1; i += 1) {
      await recordProviderSendOutcome(provider, "ses", { successful: false, errors: ["x"], failure: "transient" });
      expect((await listProviderHealth())[0]?.ok).not.toBe(false);
    }

    await recordProviderSendOutcome(provider, "ses", { successful: false, errors: ["x"], failure: "transient" });
    expect((await listProviderHealth())[0]?.ok).toBe(false);
  });

  it("clears the failure count and reports ok the moment a send succeeds", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const provider = fixture.providerId;
    for (let i = 0; i < SEND_FAILURE_THRESHOLD; i += 1) {
      await recordProviderSendOutcome(provider, "ses", { successful: false, errors: ["x"], failure: "backoff", retryAfterSeconds: 5 });
    }
    expect((await listProviderHealth())[0]?.ok).toBe(false);

    await recordProviderSendOutcome(provider, "ses", { successful: true, providerMessageId: "m1" });
    expect((await listProviderHealth())[0]?.ok).toBe(true);
  });

  it("treats a permanent failure as evidence about the message, not the provider", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const provider = fixture.providerId;
    await recordProviderProbe(provider, "ses", { ok: true, detail: null });

    for (let i = 0; i < SEND_FAILURE_THRESHOLD + 2; i += 1) {
      await recordProviderSendOutcome(provider, "ses", { successful: false, errors: ["bad address"], failure: "permanent" });
    }

    expect((await listProviderHealth())[0]?.ok).toBe(true);
  });
});

describe("ProviderHealthLoop", () => {
  it("probes every provider and records the adapter's own verdict", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const loop = new ProviderHealthLoop({ intervalMs: 60_000 });

    const checked = await loop.tick();

    expect(checked).toBe(1);
    const [health] = await listProviderHealth();
    expect(health?.providerId).toBe(fixture.providerId);
    expect(health).toMatchObject({ ok: true, detail: null, source: "probe" });
  });

  it("records a threw check as down instead of leaving it unchecked", async () => {
    process.env.REDIS_URL = REDIS_URL;
    // An adapter the registry doesn't have throws building the provider.
    await addProvider(fixture, { providerAdapter: "not-a-real-adapter" });

    const loop = new ProviderHealthLoop({ intervalMs: 60_000 });
    await loop.tick();

    const broken = (await listProviderHealth()).find((entry) => entry.adapter === "not-a-real-adapter");
    expect(broken?.ok).toBe(false);
    expect(broken?.detail).toBe("The health check threw.");
  });

  describe("a provider backing off past the window", () => {
    it("sends exactly one alert, idempotent on backingOffSince", async () => {
      process.env.REDIS_URL = REDIS_URL;
      await seedSystemOrganization();
      const since = new Date(Date.now() - 30 * 60_000 - 60_000);
      await db
        .update(providers)
        .set({ backoffUntil: new Date(Date.now() + 60_000), backingOffSince: since })
        .where(eq(providers.id, fixture.providerId));

      const loop = new ProviderHealthLoop({ intervalMs: 60_000 });
      await loop.tick();
      // Simulates the next pass with nothing changed — the run hasn't cleared.
      await loop.tick();

      expect(await systemMailMessages()).toHaveLength(1);
    });

    it("doesn't alert while the backoff run is still inside the window", async () => {
      process.env.REDIS_URL = REDIS_URL;
      await seedSystemOrganization();
      await db
        .update(providers)
        .set({ backoffUntil: new Date(Date.now() + 60_000), backingOffSince: new Date(Date.now() - 60_000) })
        .where(eq(providers.id, fixture.providerId));

      await new ProviderHealthLoop({ intervalMs: 60_000 }).tick();

      expect(await systemMailMessages()).toHaveLength(0);
    });

    it("waits for the window the operator set", async () => {
      process.env.REDIS_URL = REDIS_URL;
      await seedSystemOrganization();
      await setStoredSetting("provider_backoff_alert_minutes", 60);
      await db
        .update(providers)
        .set({ backoffUntil: new Date(Date.now() + 60_000), backingOffSince: new Date(Date.now() - 45 * 60_000) })
        .where(eq(providers.id, fixture.providerId));

      await new ProviderHealthLoop({ intervalMs: 60_000 }).tick();
      expect(await systemMailMessages()).toHaveLength(0);

      await setStoredSetting("provider_backoff_alert_minutes", 40);
      await new ProviderHealthLoop({ intervalMs: 60_000 }).tick();
      expect(await systemMailMessages()).toHaveLength(1);
    });

    it("doesn't alert a provider that isn't backing off", async () => {
      process.env.REDIS_URL = REDIS_URL;
      await seedSystemOrganization();

      await new ProviderHealthLoop({ intervalMs: 60_000 }).tick();

      expect(await systemMailMessages()).toHaveLength(0);
    });
  });
});

describe("ProviderHealthLoop: backfilling provider_identity", () => {
  it("leaves the identity null for an adapter with no such concept, like mock", async () => {
    process.env.REDIS_URL = REDIS_URL;

    await new ProviderHealthLoop({ intervalMs: 60_000 }).tick();

    const [row] = await db.select().from(providers).where(eq(providers.id, fixture.providerId));
    expect(row?.providerIdentity).toBeNull();
  });

  it("stores the identity an adapter answers with", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const real = providersModule.adapterFor;
    const spy = vi.spyOn(providersModule, "adapterFor").mockImplementation((provider) => ({
      ...real(provider),
      identity: async () => "aws-provider-42",
    }));

    await new ProviderHealthLoop({ intervalMs: 60_000 }).tick();
    spy.mockRestore();

    const [row] = await db.select().from(providers).where(eq(providers.id, fixture.providerId));
    expect(row?.providerIdentity).toBe("aws-provider-42");
  });

  it("never overwrites a known identity with a null from a failed or inconclusive call", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await db.update(providers).set({ providerIdentity: "aws-provider-42" }).where(eq(providers.id, fixture.providerId));
    const real = providersModule.adapterFor;
    const spy = vi.spyOn(providersModule, "adapterFor").mockImplementation((provider) => ({
      ...real(provider),
      identity: async () => null,
    }));

    await new ProviderHealthLoop({ intervalMs: 60_000 }).tick();
    spy.mockRestore();

    const [row] = await db.select().from(providers).where(eq(providers.id, fixture.providerId));
    expect(row?.providerIdentity).toBe("aws-provider-42");
  });
});

describe("readiness", () => {
  it("is ok end to end against the local stack, with every dependency reported separately", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    await recordHeartbeat("worker-readyz-test");

    const report = await readiness();

    expect(report.ok).toBe(true);
    expect(report.checks.postgres).toEqual({ ok: true, critical: true, detail: null });
    expect(report.checks.redis).toEqual({ ok: true, critical: true, detail: null });
    expect(report.checks.storage).toEqual({ ok: true, critical: true, detail: null });
    expect(report.checks.worker).toEqual({ ok: true, critical: true, detail: null, count: 1 });
    expect(report.checks.providers).toEqual({ ok: true, critical: true, detail: null, total: 1, down: 0 });
  });

  it("fails when the worker has never reported in", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();

    const report = await readiness();
    expect(report.ok).toBe(false);
    expect(report.checks.worker).toEqual({ ok: false, critical: true, detail: "No worker has reported in.", count: 0 });
  });

  it("stays ready with several workers up, and reports how many — the honest floor is at least one", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    await recordHeartbeat("worker-a");
    await recordHeartbeat("worker-b");
    await recordHeartbeat("worker-c");

    const report = await readiness();
    expect(report.ok).toBe(true);
    expect(report.checks.worker).toEqual({ ok: true, critical: true, detail: null, count: 3 });
  });

  it("stays ready when some workers have gone quiet, as long as one hasn't — the queue still drains", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    await recordHeartbeat("worker-survivor");
    const stale = new Date(Date.now() - (HEARTBEAT_TTL_SECONDS + 60) * 1000).toISOString();
    await redis()?.set(`${HEARTBEAT_KEY_PREFIX}worker-dead`, JSON.stringify({ workerId: "worker-dead", at: stale }));

    const report = await readiness();
    expect(report.ok).toBe(true);
    expect(report.checks.worker).toEqual({ ok: true, critical: true, detail: null, count: 1 });
  });

  it("fails when a dependency the app can check live is down", async () => {
    delete process.env.REDIS_URL;
    await closeRedis();

    const report = await readiness();
    expect(report.ok).toBe(false);
    expect(report.checks.redis?.ok).toBe(false);
  });

  it("fails when a provider is down, and counts it without naming it", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    await recordHeartbeat("worker-readyz-test");
    await recordProviderProbe(fixture.providerId, "ses", { ok: false, detail: "Credentials were rejected." });

    const report = await readiness();
    expect(report.ok).toBe(false);
    expect(report.checks.providers).toEqual({ ok: false, critical: true, detail: "A provider in use is down.", total: 1, down: 1 });
  });

  it("doesn't fail readiness over an adapter that simply can't probe itself", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    await recordHeartbeat("worker-readyz-test");
    await addProvider(fixture, { providerAdapter: "mailpace", name: "no-org-token" });

    const report = await readiness();
    expect(report.ok).toBe(true);
    // The new provider has no domains bound, so it isn't among the providers a send depends on.
    expect(report.checks.providers).toEqual({ ok: true, critical: true, detail: null, total: 1, down: 0 });
  });

  it("answers within the deadline when a check hangs, and says so rather than reporting it fine", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    await recordHeartbeat("worker-readyz-test");
    vi.spyOn(healthChecks, "listProviderHealth").mockImplementation(
      () => new Promise(() => {}) as ReturnType<typeof healthChecks.listProviderHealth>,
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = readiness();
      await vi.advanceTimersByTimeAsync(READINESS_DEADLINE_MS);
      const report = await pending;

      expect(report.ok).toBe(false);
      expect(report.checks.providers).toEqual({ ok: false, critical: true, detail: "Check didn't answer in time." });
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("stays ready when a dormant provider is down, since nothing sends through it", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    await recordHeartbeat("worker-readyz-test");
    const dormant = await addProvider(fixture, { providerAdapter: "mailpace", name: "retired" });
    await recordProviderProbe(dormant.providerId, "mailpace", {
      ok: false,
      detail: "Credentials were rejected.",
    });

    const report = await readiness();
    expect(report.ok).toBe(true);
    expect(report.checks.providers).toEqual({ ok: true, critical: true, detail: null, total: 1, down: 0 });
  });

  it("carries no internal identifiers in the unauthenticated body — no provider id, no provider adapter name", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    await recordHeartbeat("worker-readyz-test");
    await recordProviderProbe(fixture.providerId, "ses", { ok: false, detail: "Credentials were rejected." });
    await queue(fixture);

    const body = JSON.stringify(await readiness());

    expect(body).not.toContain(fixture.providerId);
    expect(body).not.toMatch(/\bpac_/);
    for (const providerAdapter of ["ses", "mailpace", "mock"]) {
      expect(body.toLowerCase()).not.toContain(providerAdapter);
    }
    expect(body).not.toContain("depth");
    expect(body).not.toContain("oldestQueuedAt");
    expect(body).not.toContain("lastBeatAt");
    expect(body).not.toContain("worker-readyz-test");
  });
});

describe("readHeartbeats", () => {
  it("reports nothing when no worker has beaten", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    expect(await readHeartbeats()).toEqual([]);
  });

  it("shows several workers heartbeating concurrently as several, each with its own last-beat time", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();

    await recordHeartbeat("worker-1");
    await recordHeartbeat("worker-2");
    await recordHeartbeat("worker-3");

    const beats = await readHeartbeats();
    expect(beats).toHaveLength(3);
    const ids = beats.map((beat) => beat.workerId).sort();
    expect(ids).toEqual(["worker-1", "worker-2", "worker-3"]);
    for (const beat of beats) {
      expect(typeof beat.at).toBe("string");
    }
  });

  it("drops a worker once its heartbeat goes stale, while the others stay", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    await recordHeartbeat("worker-survivor");
    const stale = new Date(Date.now() - (HEARTBEAT_TTL_SECONDS + 60) * 1000).toISOString();
    await redis()?.set(`${HEARTBEAT_KEY_PREFIX}worker-dead`, JSON.stringify({ workerId: "worker-dead", at: stale }));

    const beats = await readHeartbeats();
    expect(beats.map((beat) => beat.workerId)).toEqual(["worker-survivor"]);
  });
});

describe("GET /healthz", () => {
  function healthzRequest(query = ""): Request {
    return new Request(`http://localhost/healthz${query}`);
  }

  it("bare call never invokes the readiness checks", async () => {
    const postgresSpy = vi.spyOn(healthChecks, "checkPostgres");
    const redisSpy = vi.spyOn(healthChecks, "checkRedis");
    const storageSpy = vi.spyOn(healthChecks, "checkStorage");
    const queueSpy = vi.spyOn(healthChecks, "checkQueue");
    const providersSpy = vi.spyOn(healthChecks, "listProviderHealth");
    const heartbeatSpy = vi.spyOn(healthModule, "readHeartbeats");

    const res = await healthz(healthzRequest());

    expect(res.status).toBe(200);
    expect(postgresSpy).not.toHaveBeenCalled();
    expect(redisSpy).not.toHaveBeenCalled();
    expect(storageSpy).not.toHaveBeenCalled();
    expect(queueSpy).not.toHaveBeenCalled();
    expect(providersSpy).not.toHaveBeenCalled();
    expect(heartbeatSpy).not.toHaveBeenCalled();

    postgresSpy.mockRestore();
    redisSpy.mockRestore();
    storageSpy.mockRestore();
    queueSpy.mockRestore();
    providersSpy.mockRestore();
    heartbeatSpy.mockRestore();
  });

  it("bare call returns 200 with just ok and database while a dependency is down", async () => {
    delete process.env.REDIS_URL;
    await closeRedis();

    const res = await healthz(healthzRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, database: true });
  });

  it("bare call returns 503 when Postgres is unreachable", async () => {
    const pingDbSpy = vi.spyOn(dbModule, "pingDb").mockResolvedValueOnce(false);

    const res = await healthz(healthzRequest());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, database: false });

    pingDbSpy.mockRestore();
  });

  it("?detail returns 200 with the full report when everything is up", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    await recordHeartbeat("worker-healthz-detail-test");

    const res = await healthz(healthzRequest("?detail"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.postgres).toEqual({ ok: true, critical: true, detail: null });
    expect(body.checks.redis).toEqual({ ok: true, critical: true, detail: null });
    expect(body.checks.worker).toEqual({ ok: true, critical: true, detail: null, count: 1 });
    expect(body.checks.providers).toEqual({ ok: true, critical: true, detail: null, total: 1, down: 0 });
  });

  it("?detail reports a worker count and no worker ids", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    await recordHeartbeat("worker-alpha");
    await recordHeartbeat("worker-beta");

    const res = await healthz(healthzRequest("?detail"));
    const body = await res.json();

    expect(body.checks.worker).toEqual({ ok: true, critical: true, detail: null, count: 2 });
    expect(JSON.stringify(body)).not.toContain("worker-alpha");
    expect(JSON.stringify(body)).not.toContain("worker-beta");
  });

  it("?detail degrades, and stays 200, for a loop that never ran, one that threw and one gone quiet", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    await recordHeartbeat("worker-healthz-detail-test");
    await everyJobRan();

    const clean = await (await healthz(healthzRequest("?detail"))).json();
    expect(clean.checks.jobs).toEqual({ ok: true, critical: false, detail: null, stale: 0, failing: 0, never: 0 });

    await recordJobFinish("send", JOB_ERROR);
    await db.update(jobHeartbeats).set({ lastBeatAt: new Date(Date.now() - 60 * 60_000) }).where(eq(jobHeartbeats.name, "verify"));
    await db.delete(jobHeartbeats).where(eq(jobHeartbeats.name, "digest"));

    const res = await healthz(healthzRequest("?detail"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "degraded", degraded: ["jobs"] });
    expect(body.checks.jobs).toMatchObject({ ok: false, critical: false, stale: 1, failing: 1, never: 1 });
    expect(JSON.stringify(body)).not.toContain("verify");
  });

  it("?detail stays 200 and says degraded when only the assets bucket is unreachable", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    await recordHeartbeat("worker-healthz-detail-test");
    await everyJobRan();
    const saved = process.env.STORAGE_ASSETS_BUCKET;
    process.env.STORAGE_ASSETS_BUCKET = "pouch-no-such-assets-bucket";
    try {
      const res = await healthz(healthzRequest("?detail"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, status: "degraded", degraded: ["assets"] });
      expect(body.checks.assets).toEqual({ ok: false, critical: false, detail: "Bucket not found." });
    } finally {
      if (saved === undefined) delete process.env.STORAGE_ASSETS_BUCKET;
      else process.env.STORAGE_ASSETS_BUCKET = saved;
    }
  });

  it("?detail leaves out the assets check when no assets bucket is configured", async () => {
    const saved = process.env.STORAGE_ASSETS_BUCKET;
    delete process.env.STORAGE_ASSETS_BUCKET;
    try {
      const body = await (await healthz(healthzRequest("?detail"))).json();
      expect(body.checks.assets).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.STORAGE_ASSETS_BUCKET = saved;
    }
  });

  it("?detail returns 503 when a dependency is down", async () => {
    delete process.env.REDIS_URL;
    await closeRedis();

    const res = await healthz(healthzRequest("?detail"));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.redis.ok).toBe(false);
  });
});
