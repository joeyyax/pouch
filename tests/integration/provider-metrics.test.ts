import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { activity, messages, providers, providerFindings, type MessageStatus } from "@/lib/db/schema";
import * as providersModule from "@/lib/providers";
import { encryptCredentials, type ProviderRow } from "@/lib/providers";
import {
  DENIED_RECHECK_SECONDS,
  readQuotas,
  readRates,
  readTenantVolume,
  resetProviderMetricsMemory,
  writeQuota,
  writeRates,
} from "@/lib/providers/provider-metrics";
import { listProviderMetrics } from "@/lib/system/read";
import { listProviderHealth } from "@/lib/health/checks";
import { newId } from "@/lib/ids";
import { sendPushAlert } from "@/lib/notifications/push/push";
import type { AccountQuota, AccountRates, Adapter, MetricRead, TenantFindings, TenantVolume } from "@/lib/providers/adapters/types";
import { closeRedis, redis } from "@/lib/redis";
import { recordProviderFinding } from "@/lib/reputation/provider-findings";
import { readOrganizationReputation } from "@/lib/reputation/read";
import { ProviderHealthLoop } from "@/worker/health-check";
import { providerRow, resetDatabase, seedFixture, type Fixture } from "./fixtures";
import { clearRedisKeys, testRedisUrl } from "../redis";

vi.mock("@/lib/notifications/push/push", () => ({ sendPushAlert: vi.fn().mockResolvedValue(undefined) }));

const REDIS_URL = testRedisUrl();
const DAY_MS = 24 * 60 * 60 * 1000;
const DENIED: MetricRead<AccountRates> = { state: "denied", permission: "cloudwatch:GetMetricData" };

interface Fake {
  quota?: AccountQuota | null;
  rates?: MetricRead<AccountRates>;
  findings?: TenantFindings | null;
  volume?: MetricRead<TenantVolume>;
}

const fakes = new Map<string, Fake>();
const calls = { quota: 0, rates: 0, findings: 0, volume: 0 };

function quota(sent: number, max = 50_000): AccountQuota {
  return { max24HourSend: max, maxSendRate: 14, sentLast24Hours: sent, enforcementStatus: "HEALTHY" };
}

function rates(bounceRate: number | null, complaintRate: number | null = 0): MetricRead<AccountRates> {
  return { state: "ok", value: { bounceRate, complaintRate, at: new Date() } };
}

function fakeProviders(): void {
  const real = providersModule.adapterFor;
  vi.spyOn(providersModule, "adapterFor").mockImplementation((row: ProviderRow): Adapter => {
    const provider = real(row);
    const fake = fakes.get(row.id);
    if (!fake) return provider;
    return {
      ...provider,
      healthCheck: async () => ({ ok: true, detail: null }),
      quota: async () => {
        calls.quota += 1;
        return fake.quota ?? null;
      },
      reputationRates: async () => {
        calls.rates += 1;
        return fake.rates ?? { state: "failed" };
      },
      tenants: {
        parseStatus: () => [],
        status: async () => "enabled",
        findings: async () => {
          calls.findings += 1;
          return fake.findings ?? null;
        },
        volume: async () => {
          calls.volume += 1;
          return fake.volume ?? { state: "failed" };
        },
      },
    };
  });
}

async function tick(): Promise<void> {
  await new ProviderHealthLoop({ intervalMs: 60_000, probeSpacingMs: 0 }).tick();
}

async function clearRedis(): Promise<void> {
  await clearRedisKeys("provider-metrics:", "health:");
}

async function insertMessages(fixture: Fixture, count: number, status: MessageStatus, createdAt: Date): Promise<void> {
  if (count === 0) return;
  await db.insert(messages).values(
    Array.from({ length: count }, () => ({
      id: newId("message"),
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      status,
      fromAddress: "hi@example.com",
      recipients: ["person@example.net"],
      subject: "Hello",
      envelope: { from: "hi@example.com", fromName: null, to: ["person@example.net"], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
      tags: [],
      createdAt,
    })),
  );
}

let fixture: Fixture;

beforeEach(async () => {
  process.env.REDIS_URL = REDIS_URL;
  await clearRedis();
  resetProviderMetricsMemory();
  await resetDatabase();
  fixture = await seedFixture();
  fakes.clear();
  Object.assign(calls, { quota: 0, rates: 0, findings: 0, volume: 0 });
  vi.mocked(sendPushAlert).mockClear();
  fakeProviders();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clearRedis();
  delete process.env.REDIS_URL;
  await closeRedis();
});

describe("send quota", () => {
  it("stores the quota for the system view", async () => {
    fakes.set(fixture.providerId, { quota: quota(4), rates: rates(0.001) });

    await tick();

    expect((await readQuotas([fixture.providerId])).get(fixture.providerId)).toMatchObject({
      max24HourSend: 50_000,
      sentLast24Hours: 4,
      enforcementStatus: "HEALTHY",
    });
    const [view] = await listProviderMetrics();
    expect(view).toMatchObject({ providerNames: ["primary"], quota: { sentLast24Hours: 4 }, rates: { state: "ok", bounceRate: 0.001 } });
  });

  it("shows a shared provider's quota, under the organizations its tenants serve", async () => {
    const shared = await addShared();
    await attach(fixture, shared, "org_a");
    await writeQuota([shared], quota(12), await dbNow());
    const [view] = await listProviderMetrics();
    expect(view).toMatchObject({ providerNames: ["Hosted"], organizationNames: ["Test"], shared: true, quota: { sentLast24Hours: 12 } });
  });

  it("warns operators once when usage crosses 80%, and again only after it drops back", async () => {
    const fake: Fake = { quota: quota(39_999), rates: rates(0) };
    fakes.set(fixture.providerId, fake);
    const quotaPushes = () => vi.mocked(sendPushAlert).mock.calls.filter(([input]) => input.title.startsWith("Send quota"));

    await tick();
    expect(quotaPushes()).toHaveLength(0);

    fake.quota = quota(40_000);
    await tick();
    await tick();
    expect(quotaPushes()).toHaveLength(1);
    expect(quotaPushes()[0]?.[0].title).toBe("Send quota at 80%: primary");

    fake.quota = quota(100);
    await tick();
    fake.quota = quota(45_000);
    await tick();
    expect(quotaPushes()).toHaveLength(2);
  });
});

describe("provider reputation rates", () => {
  it("records a denied CloudWatch read as denied, keeps the provider healthy and waits before asking again", async () => {
    fakes.set(fixture.providerId, { quota: quota(4), rates: DENIED });

    await tick();
    await tick();

    const reading = (await readRates([fixture.providerId])).get(fixture.providerId);
    expect(reading).toMatchObject({ state: "denied", permission: "cloudwatch:GetMetricData" });
    expect(calls.rates).toBe(1);
    const health = (await listProviderHealth()).find((view) => view.providerId === fixture.providerId);
    expect(health).toMatchObject({ ok: true, detail: null });
    expect(sendPushAlert).not.toHaveBeenCalled();
    const [view] = await listProviderMetrics();
    expect(view?.rates).toMatchObject({ state: "denied", permission: "cloudwatch:GetMetricData" });

    const stale = new Date((await dbNow()).getTime() - DENIED_RECHECK_SECONDS * 1000);
    await writeRates([fixture.providerId], DENIED, stale);
    await tick();
    expect(calls.rates).toBe(2);
  });

  it("leaves a denied provider out of the organization's standing", async () => {
    await writeRates([fixture.providerId], DENIED, await dbNow());

    const reputation = await readOrganizationReputation(fixture.organizationId, await dbNow());

    expect(reputation.ownStanding).toBe("healthy");
  });

  it("pushes once when AWS's rate crosses the at-risk line", async () => {
    fakes.set(fixture.providerId, { quota: quota(4), rates: rates(0.021) });

    await tick();
    await clearRedisKeys("provider-metrics:rates:");
    await tick();

    const ratePushes = vi.mocked(sendPushAlert).mock.calls.filter(([input]) => input.title.startsWith("AWS bounce rate"));
    expect(ratePushes).toHaveLength(1);
    expect(calls.rates).toBe(2);
  });

  it("puts the organization at risk when AWS's rate for its own provider crosses the line", async () => {
    await writeRates([fixture.providerId], rates(0.03), await dbNow());

    const reputation = await readOrganizationReputation(fixture.organizationId, await dbNow());

    expect(reputation.ownStanding).toBe("at_risk");
    expect(reputation.findings[0]).toMatchObject({ kind: "provider_rate", domainId: fixture.domainId });
  });

  it("stays out when the domain already reports its own bounce rate", async () => {
    const now = await dbNow();
    await insertMessages(fixture, 970, "delivered", new Date(now.getTime() - DAY_MS));
    await insertMessages(fixture, 30, "bounced", new Date(now.getTime() - DAY_MS));
    await writeRates([fixture.providerId], rates(0.03), now);

    const reputation = await readOrganizationReputation(fixture.organizationId, now);

    expect(reputation.domains.get(fixture.domainId)?.standing).not.toBe("healthy");
    expect(reputation.findings.some((finding) => finding.kind === "provider_rate")).toBe(false);
  });

  it("doesn't raise a tenant's standing with the shared provider's rate", async () => {
    const shared = await addShared();
    await db.update(providers).set({ sharedProviderId: shared }).where(eq(providers.id, fixture.providerId));
    await writeRates([fixture.providerId, shared], rates(0.03), await dbNow());

    const reputation = await readOrganizationReputation(fixture.organizationId, await dbNow());

    expect(reputation.ownStanding).toBe("healthy");
  });
});

async function addShared(): Promise<string> {
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

async function attach(target: Fixture, sharedId: string, name: string): Promise<string> {
  const tenantArn = `arn:aws:ses:us-west-2:111122223333:tenant/${name}/tn-${name}`;
  await db
    .update(providers)
    .set({ sharedProviderId: sharedId, settings: { tenantName: name, tenantArn } })
    .where(eq(providers.id, target.providerId));
  return tenantArn;
}

describe("tenant findings backstop", () => {
  async function openedActivity(): Promise<number> {
    return (await db.select().from(activity).where(eq(activity.action, "provider.finding.opened"))).length;
  }

  async function finding(providerId: string, type: string) {
    const [found] = await db
      .select()
      .from(providerFindings)
      .where(and(eq(providerFindings.providerId, providerId), eq(providerFindings.type, type)));
    return found;
  }

  it("opens a finding the events missed, closes one AWS no longer lists and doesn't repeat itself", async () => {
    const sharedId = await addShared();
    const other = await seedFixture();
    const arnA = await attach(fixture, sharedId, "org_a");
    await attach(other, sharedId, "org_b");
    await recordProviderFinding({
      organizationId: other.organizationId,
      providerId: other.providerId,
      kind: "finding_opened",
      type: "COMPLAINT",
      impact: "LOW",
      description: null,
    });
    const openedAt = new Date("2026-09-10T00:00:00Z");
    fakes.set(sharedId, {
      findings: {
        complete: true,
        findings: [{ tenantRef: arnA, tenantName: "org_a", type: "BOUNCE", impact: "HIGH", description: "Bounces.", openedAt }],
      },
    });

    await tick();

    expect(await finding(fixture.providerId, "BOUNCE")).toMatchObject({ impact: "HIGH", closedAt: null, openedAt });
    expect((await finding(other.providerId, "COMPLAINT"))?.closedAt).not.toBeNull();
    expect(await openedActivity()).toBe(1);
    expect(vi.mocked(sendPushAlert).mock.calls.filter(([input]) => input.title.startsWith("Reputation finding"))).toHaveLength(1);

    await redis()!.del(`health:tenant-sweep:${sharedId}`);
    await tick();
    expect(calls.findings).toBe(1);

    await redis()!.del(`provider-metrics:findings-sweep:${sharedId}`, `health:tenant-sweep:${sharedId}`);
    await tick();
    expect(calls.findings).toBe(2);
    expect(await openedActivity()).toBe(1);
    expect(vi.mocked(sendPushAlert).mock.calls.filter(([input]) => input.title.startsWith("Reputation finding"))).toHaveLength(1);

    const reputation = await readOrganizationReputation(fixture.organizationId, await dbNow());
    expect(reputation.ownStanding).toBe("at_risk");
    expect(reputation.findings[0]).toMatchObject({ kind: "provider_finding", domainId: fixture.domainId });
  });

  it("closes nothing when the list was cut short", async () => {
    const sharedId = await addShared();
    await attach(fixture, sharedId, "org_a");
    await recordProviderFinding({
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      kind: "finding_opened",
      type: "COMPLAINT",
      impact: "LOW",
      description: null,
    });
    fakes.set(sharedId, { findings: { complete: false, findings: [] } });

    await tick();

    expect(calls.findings).toBe(1);
    expect((await finding(fixture.providerId, "COMPLAINT"))?.closedAt).toBeNull();
  });

  it("reads nothing for an ordinary provider", async () => {
    fakes.set(fixture.providerId, { findings: { complete: true, findings: [] } });

    await tick();

    expect(calls.findings).toBe(0);
  });
});

describe("tenant counts", () => {
  it("reads a tenant's counts through its shared provider and caches them", async () => {
    const sharedId = await addShared();
    await attach(fixture, sharedId, "org_a");
    fakes.set(sharedId, { volume: { state: "ok", value: { sends: 120, bounces: 3, complaints: 1 } } });

    expect(await readTenantVolume(await providerRow(fixture.providerId))).toEqual({ sends: 120, bounces: 3, complaints: 1 });
    expect(await readTenantVolume(await providerRow(fixture.providerId))).toEqual({ sends: 120, bounces: 3, complaints: 1 });
    expect(calls.volume).toBe(1);
  });

  it("skips quietly when CloudWatch is denied, without asking again", async () => {
    const sharedId = await addShared();
    await attach(fixture, sharedId, "org_a");
    fakes.set(sharedId, { volume: DENIED as MetricRead<TenantVolume> });

    expect(await readTenantVolume(await providerRow(fixture.providerId))).toBeNull();
    expect(await readTenantVolume(await providerRow(fixture.providerId))).toBeNull();
    expect(calls.volume).toBe(1);
  });

  it("doesn't ask when the shared provider's own read was denied", async () => {
    const sharedId = await addShared();
    await attach(fixture, sharedId, "org_a");
    await writeRates([sharedId], DENIED, await dbNow());
    fakes.set(sharedId, { volume: { state: "ok", value: { sends: 1, bounces: 0, complaints: 0 } } });

    expect(await readTenantVolume(await providerRow(fixture.providerId))).toBeNull();
    expect(calls.volume).toBe(0);
  });

  it("has nothing to read for an ordinary provider", async () => {
    expect(await readTenantVolume(await providerRow(fixture.providerId))).toBeNull();
  });
});
