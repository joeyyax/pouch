/**
 * #409: the cluster goes out over push, on the transition. What has to hold is that crossing the
 * line pushes exactly once however often the check runs, that falling back out re-arms it, and
 * that a number produced by nothing — no marking loop — never pushes at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, jobHeartbeats, messages, organizations, providers } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { encryptCredentials } from "@/lib/providers";
import { UNCONFIRMED_CLUSTER_FLOOR } from "@/lib/system/views";
import { JOB_ERROR, recordJobFinish, recordJobStart } from "@/lib/health";
import { checkUnconfirmedCluster, resetUnconfirmedClusterAlert } from "@/lib/messages/unconfirmed-alert";
import { ABANDON_MS } from "@/lib/metrics/conditions";
import { sendPushAlert } from "@/lib/notifications/push/push";
import { closeRedis } from "@/lib/redis";
import { webhookUrl } from "@/lib/webhooks/url";
import { resetDatabase } from "./fixtures";
import { testRedisUrl } from "../redis";

vi.mock("@/lib/notifications/push/push", () => ({ sendPushAlert: vi.fn().mockResolvedValue(undefined) }));

const REDIS_URL = testRedisUrl();
const ABANDON_INTERVAL_MS = 60_000;

async function abandonRan(): Promise<void> {
  await recordJobStart("abandon", ABANDON_INTERVAL_MS, "worker-1");
  await recordJobFinish("abandon", null);
}

let organizationId: string;
let domainId: string;
let providerId: string;

async function seedSends(options: { count: number; sentAt: Date; abandonedAt?: Date | null }): Promise<void> {
  if (options.count === 0) return;
  const from = "hi@example.com";
  await db.insert(messages).values(
    Array.from({ length: options.count }, () => ({
      id: newId("message"),
      organizationId,
      domainId,
      providerId,
      status: "sent" as const,
      fromAddress: from,
      recipients: ["person@example.net"],
      subject: "Hi",
      envelope: { from, fromName: null, to: ["person@example.net"], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
      tags: [],
      createdAt: options.sentAt,
      sentAt: options.sentAt,
      abandonedAt: options.abandonedAt ?? null,
    })),
  );
}

/** Enough marks on their own sends to cross both the floor and the share. */
async function seedCluster(): Promise<void> {
  const now = await dbNow();
  await seedSends({ count: UNCONFIRMED_CLUSTER_FLOOR, sentAt: new Date(now.getTime() - ABANDON_MS - 60_000), abandonedAt: now });
}

/** Sends the marks are drowned in: same marks, a share too small to be a cluster. */
async function seedQuietVolume(): Promise<void> {
  const now = await dbNow();
  await seedSends({ count: UNCONFIRMED_CLUSTER_FLOOR * 100, sentAt: new Date(now.getTime() - ABANDON_MS - 60_000) });
}

beforeEach(async () => {
  await resetDatabase();
  process.env.REDIS_URL = REDIS_URL;
  await db.delete(jobHeartbeats);
  await resetUnconfirmedClusterAlert();
  vi.mocked(sendPushAlert).mockClear();

  organizationId = newId("organization");
  await db.insert(organizations).values({ id: organizationId, name: "Org", slug: `slug-${organizationId}` });
  providerId = newId("provider");
  await db.insert(providers).values({
    id: providerId,
    organizationId,
    adapter: "ses",
    name: "primary",
    credentials: encryptCredentials({}),
    settings: {},
  });
  domainId = newId("domain");
  await db.insert(domains).values({
    id: domainId,
    organizationId,
    providerId,
    name: `${organizationId}.example.com`,
    status: "verified",
    verifiedAt: new Date(),
  });
});

afterEach(async () => {
  await resetUnconfirmedClusterAlert();
  await db.delete(jobHeartbeats);
  delete process.env.REDIS_URL;
  await closeRedis();
});

describe("checkUnconfirmedCluster", () => {
  it("pushes once on the way into clustered, however many times it runs after", async () => {
    await abandonRan();
    await seedCluster();

    expect(await checkUnconfirmedCluster()).toBe(true);
    expect(await checkUnconfirmedCluster()).toBe(false);
    expect(await checkUnconfirmedCluster()).toBe(false);
    expect(sendPushAlert).toHaveBeenCalledTimes(1);
  });

  it("pushes again once the cluster has cleared and come back — the flag is the transition, not a mute", async () => {
    await abandonRan();
    await seedCluster();
    expect(await checkUnconfirmedCluster()).toBe(true);

    // The same marks against far more sends: a share this small is ordinary provider silence.
    await seedQuietVolume();
    expect(await checkUnconfirmedCluster()).toBe(false);

    await db.delete(messages);
    await seedCluster();
    expect(await checkUnconfirmedCluster()).toBe(true);
    expect(sendPushAlert).toHaveBeenCalledTimes(2);
  });

  it("stays quiet while nothing is clustering", async () => {
    await abandonRan();
    await seedQuietVolume();

    expect(await checkUnconfirmedCluster()).toBe(false);
    expect(sendPushAlert).not.toHaveBeenCalled();
  });

  it("never pushes with no marking loop reporting: the count means nothing either way", async () => {
    await seedCluster();

    expect(await checkUnconfirmedCluster()).toBe(false);
    expect(sendPushAlert).not.toHaveBeenCalled();

    // The same window, once a worker is marking again.
    await abandonRan();
    expect(await checkUnconfirmedCluster()).toBe(true);
  });

  it("stays quiet while the marking loop's last run threw, since it isn't producing the count", async () => {
    await recordJobStart("abandon", ABANDON_INTERVAL_MS, "worker-1");
    await recordJobFinish("abandon", JOB_ERROR);
    await seedCluster();

    expect(await checkUnconfirmedCluster()).toBe(false);
    expect(sendPushAlert).not.toHaveBeenCalled();
  });

  it("ignores another loop's heartbeat — the send loop running says nothing about marking", async () => {
    await recordJobStart("send", 2000, "worker-1");
    await recordJobFinish("send", null);
    await seedCluster();

    expect(await checkUnconfirmedCluster()).toBe(false);
    expect(sendPushAlert).not.toHaveBeenCalled();
  });

  it("sends the operator to the subscription, naming the endpoint the events should have reached", async () => {
    await abandonRan();
    await seedCluster();

    await checkUnconfirmedCluster();

    const [input] = vi.mocked(sendPushAlert).mock.calls[0] ?? [];
    expect(input?.message).toContain(webhookUrl("ses", providerId));
    expect(input?.message).toContain("subscription");
    expect(input?.click).toContain("/admin/settings/system");
  });

  it("leaves the transition unclaimed when the push itself fails, so the next check retries it", async () => {
    await abandonRan();
    await seedCluster();
    vi.mocked(sendPushAlert).mockRejectedValueOnce(new Error("ntfy responded 503"));

    expect(await checkUnconfirmedCluster()).toBe(false);
    expect(await checkUnconfirmedCluster()).toBe(true);
    expect(sendPushAlert).toHaveBeenCalledTimes(2);
  });
});
