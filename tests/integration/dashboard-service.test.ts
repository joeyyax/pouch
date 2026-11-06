import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, providers } from "@/lib/db/schema";
import { credentialFieldSpecsOf, readSendingProvider, readServiceHealth } from "@/lib/dashboard/service";
import { listOwners, readOrganization } from "@/lib/organizations";
import { HEARTBEAT_KEY_PREFIX, HEARTBEAT_TTL_SECONDS, recordHeartbeat } from "@/lib/health";
import { recordProviderProbe } from "@/lib/health/checks";
import { closeRedis, redis } from "@/lib/redis";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";
import { clearRedisKeys, testRedisUrl } from "../redis";

const REDIS_URL = testRedisUrl();

let fixture: Fixture;

/** Clears every worker's heartbeat, not just one key — there's no longer a single key to delete. */
async function clearHeartbeats(): Promise<void> {
  await clearRedisKeys(HEARTBEAT_KEY_PREFIX);
}

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

afterEach(async () => {
  delete process.env.REDIS_URL;
  await closeRedis();
});

afterAll(() => {
  delete process.env.REDIS_URL;
});

describe("readSendingProvider", () => {
  async function assign(providerId: string | null): Promise<void> {
    await db.update(organizations).set({ providerId: providerId }).where(eq(organizations.id, fixture.organizationId));
  }

  it("is null while nothing is assigned", async () => {
    expect(await readSendingProvider(fixture.organizationId)).toBeNull();
  });

  it("reads the assigned provider's name, adapter and status, and nothing about its credentials or limits", async () => {
    await db.update(providers).set({ adapter: "ses" }).where(eq(providers.id, fixture.providerId));
    await assign(fixture.providerId);

    const sending = await readSendingProvider(fixture.organizationId);
    expect(sending).toEqual({
      name: "primary",
      adapterLabel: "Amazon SES",
      status: "ready",
      backoffUntil: null,
      adminProviderId: fixture.providerId,
    });
  });

  it("shows only this organization's provider", async () => {
    const other = await seedFixture();
    await db.update(organizations).set({ providerId: other.providerId }).where(eq(organizations.id, other.organizationId));
    expect(await readSendingProvider(fixture.organizationId)).toBeNull();
  });

  it("reads a failed check as unavailable", async () => {
    process.env.REDIS_URL = REDIS_URL;
    await assign(fixture.providerId);
    await recordProviderProbe(fixture.providerId, "mock", { ok: false, detail: "Rejected." });

    expect((await readSendingProvider(fixture.organizationId))?.status).toBe("unavailable");
  });

  it("drops a backoff that has already passed", async () => {
    await assign(fixture.providerId);
    await db
      .update(providers)
      .set({ backoffUntil: new Date(Date.now() - 60_000) })
      .where(eq(providers.id, fixture.providerId));

    expect((await readSendingProvider(fixture.organizationId))?.backoffUntil).toBeNull();
  });
});

describe("credentialFieldSpecsOf", () => {
  it("is empty for an adapter the registry doesn't have", () => {
    expect(credentialFieldSpecsOf("retired")).toEqual([]);
  });
});

describe("readServiceHealth", () => {
  it("says unknown when Redis isn't configured, not healthy", async () => {
    delete process.env.REDIS_URL;
    await closeRedis();
    expect(await readServiceHealth()).toEqual({ worker: "unknown", workers: [] });
  });

  it("reads the worker's own beat", async () => {
    await closeRedis();
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();

    expect((await readServiceHealth()).worker).toBe("silent");

    await recordHeartbeat("worker-abc123");
    const health = await readServiceHealth();
    expect(health.worker).toBe("healthy");
    expect(health.workers).toHaveLength(1);
    expect(health.workers[0]?.id).toBe("worker-abc123");

    // The key expires, so a stopped worker stops claiming health on its own.
    expect(await redis()?.ttl(`${HEARTBEAT_KEY_PREFIX}worker-abc123`)).toBeLessThanOrEqual(HEARTBEAT_TTL_SECONDS);
  });

  it("reports a beat older than the window as silent, and drops it from the list", async () => {
    await closeRedis();
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    const stale = new Date(Date.now() - (HEARTBEAT_TTL_SECONDS + 60) * 1000).toISOString();
    await redis()?.set(`${HEARTBEAT_KEY_PREFIX}worker-old`, JSON.stringify({ workerId: "worker-old", at: stale }));

    const health = await readServiceHealth();
    expect(health.worker).toBe("silent");
    expect(health.workers).toEqual([]);
    await clearHeartbeats();
  });

  it("lists several workers heartbeating concurrently as several rows, each with its own last-beat time", async () => {
    await closeRedis();
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();

    await recordHeartbeat("worker-1");
    await recordHeartbeat("worker-2");
    await recordHeartbeat("worker-3");

    const health = await readServiceHealth();
    expect(health.worker).toBe("healthy");
    expect(health.workers).toHaveLength(3);
    expect(health.workers.map((w) => w.id).sort()).toEqual(["worker-1", "worker-2", "worker-3"]);
    for (const worker of health.workers) {
      expect(worker.lastBeatAt).toBeInstanceOf(Date);
    }
  });

  it("stays healthy with one survivor after another worker's heartbeat goes stale", async () => {
    await closeRedis();
    process.env.REDIS_URL = REDIS_URL;
    await clearHeartbeats();
    await recordHeartbeat("worker-survivor");
    const stale = new Date(Date.now() - (HEARTBEAT_TTL_SECONDS + 60) * 1000).toISOString();
    await redis()?.set(`${HEARTBEAT_KEY_PREFIX}worker-dead`, JSON.stringify({ workerId: "worker-dead", at: stale }));

    const health = await readServiceHealth();
    expect(health.worker).toBe("healthy");
    expect(health.workers.map((w) => w.id)).toEqual(["worker-survivor"]);
  });
});

describe("organization", () => {
  it("reads its own row and admins, and no one else's", async () => {
    const other = await seedFixture();
    const organization = await readOrganization(fixture.organizationId);
    expect(organization?.id).toBe(fixture.organizationId);
    expect(await readOrganization(other.organizationId)).not.toEqual(organization);
    expect(await listOwners(fixture.organizationId)).toEqual([]);
  });
});
