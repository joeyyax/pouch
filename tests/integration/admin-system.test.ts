/**
 * The load-bearing tests for #73's first slice: an admin-only, cross-organization view of
 * worker liveness, stuck locks and queue depth. Two things must hold regardless of what the UI
 * shows — a non-admin can't reach the route, server-side, and the per-organization queries
 * can never blend one organization's rows into another's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, jobHeartbeats, messageEvents, messages, organizations, providers } from "@/lib/db/schema";
import type { MessageStatus } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { encryptCredentials } from "@/lib/providers";
import { requireAdminPage } from "@/lib/dashboard/admin-guard";
import { listProviderIdentityRates, listQueueByOrganization, listStuckLocks, readLoopLiveness, readUnconfirmedCluster } from "@/lib/system/read";
import { UNCONFIRMED_CLUSTER_FLOOR, UNCONFIRMED_CLUSTER_SHARE, UNCONFIRMED_WINDOW_MS } from "@/lib/system/views";
import { ABANDON_MS } from "@/lib/metrics/conditions";
import { webhookUrl } from "@/lib/webhooks/url";
import { LOCK_TIMEOUT_MS } from "@/lib/messages/queue";
import { JOB_ERROR, LOOP_NAMES, recordJobBeat, recordJobFinish, recordJobStart } from "@/lib/health";
import { resetDatabase, seedUser } from "./fixtures";

const sessionState = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/auth/session", async () => (await import("./fixtures")).adminSessionModule(sessionState));

async function makeUser(admin: boolean): Promise<string> {
  return (await seedUser({ admin })).userId;
}

async function makeOrgWithDomain(name: string): Promise<{ organizationId: string; domainId: string }> {
  const organizationId = newId("organization");
  await db.insert(organizations).values({ id: organizationId, name, slug: `slug-${organizationId}` });
  const providerId = newId("provider");
  const { providers } = await import("@/lib/db/schema");
  const { encryptCredentials } = await import("@/lib/providers");
  await db.insert(providers).values({
    id: providerId,
    organizationId,
    adapter: "mock",
    name: "primary",
    credentials: encryptCredentials({}),
    settings: {},
  });
  const domainId = newId("domain");
  await db.insert(domains).values({
    id: domainId,
    organizationId,
    providerId,
    name: `${organizationId}.example.com`,
    status: "verified",
    verifiedAt: new Date(),
  });
  return { organizationId, domainId };
}

async function queueMessage(options: {
  organizationId: string;
  domainId: string;
  status?: "queued";
  createdAt?: Date;
  lockedAt?: Date | null;
  lockedBy?: string | null;
}): Promise<string> {
  const id = newId("message");
  const from = "hi@example.com";
  await db.insert(messages).values({
    id,
    organizationId: options.organizationId,
    domainId: options.domainId,
    status: options.status ?? "queued",
    fromAddress: from,
    recipients: ["person@example.net"],
    subject: "Hi",
    envelope: {
      from,
      fromName: null,
      to: ["person@example.net"],
      cc: [],
      bcc: [],
      replyTo: [],
      headers: {},
      attachmentCount: 0,
    },
    tags: [],
    createdAt: options.createdAt ?? new Date(),
    lockedAt: options.lockedAt ?? null,
    lockedBy: options.lockedBy ?? null,
  });
  return id;
}

async function makeOrg(name: string): Promise<string> {
  const organizationId = newId("organization");
  await db.insert(organizations).values({ id: organizationId, name, slug: `slug-${organizationId}` });
  return organizationId;
}

async function addProvider(
  organizationId: string,
  options: { adapter?: string; identity?: string | null; name?: string } = {},
): Promise<string> {
  const providerId = newId("provider");
  await db.insert(providers).values({
    id: providerId,
    organizationId,
    adapter: options.adapter ?? "ses",
    name: options.name ?? "primary",
    credentials: encryptCredentials({}),
    settings: {},
    providerIdentity: options.identity ?? null,
  });
  return providerId;
}

/** A delivery event on a provider, with just enough of a message row to satisfy the FK. */
async function addDeliveryEvent(organizationId: string, providerId: string, status: MessageStatus): Promise<void> {
  const domainId = newId("domain");
  await db.insert(domains).values({
    id: domainId,
    organizationId,
    providerId,
    name: `${domainId}.example.com`,
    status: "verified",
    verifiedAt: new Date(),
  });
  const messageId = newId("message");
  const from = "hi@example.com";
  await db.insert(messages).values({
    id: messageId,
    organizationId,
    domainId,
    status,
    fromAddress: from,
    recipients: ["person@example.net"],
    subject: "Hi",
    envelope: { from, fromName: null, to: ["person@example.net"], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
    tags: [],
  });
  await db.insert(messageEvents).values({
    id: newId("event"),
    organizationId,
    messageId,
    kind: "transition",
    status,
    providerId,
    occurredAt: new Date(),
  });
}

beforeEach(async () => {
  await resetDatabase();
  sessionState.userId = null;
});

describe("requireAdminPage: the boundary a customer-facing surface can't cross", () => {
  it("gives a non-admin a 404, server-side, not a rendered page", async () => {
    const userId = await makeUser(false);
    sessionState.userId = userId;

    await expect(requireAdminPage()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });

  it("lets an admin through", async () => {
    const userId = await makeUser(true);
    sessionState.userId = userId;

    const session = await requireAdminPage();
    expect(session.user.id).toBe(userId);
  });
});

describe("listQueueByOrganization: org-scoped queries can't return another organization's rows", () => {
  it("keeps each organization's depth and oldest-queued to its own rows", async () => {
    const orgA = await makeOrgWithDomain("Org A");
    const orgB = await makeOrgWithDomain("Org B");

    const oldA = new Date(Date.now() - 60 * 60 * 1000);
    await queueMessage({ organizationId: orgA.organizationId, domainId: orgA.domainId, createdAt: oldA });
    await queueMessage({ organizationId: orgA.organizationId, domainId: orgA.domainId });
    await queueMessage({ organizationId: orgB.organizationId, domainId: orgB.domainId });

    const rows = await listQueueByOrganization();
    const a = rows.find((row) => row.organizationId === orgA.organizationId);
    const b = rows.find((row) => row.organizationId === orgB.organizationId);

    expect(a).toBeDefined();
    expect(a!.depth).toBe(2);
    expect(a!.oldestQueuedAt?.getTime()).toBe(oldA.getTime());
    expect(b).toBeDefined();
    expect(b!.depth).toBe(1);

    // Org A's count and oldest timestamp never include org B's row, and vice versa.
    expect(a!.depth + b!.depth).toBe(3);
  });

  it("only counts queued messages, never sent or delivered ones", async () => {
    const org = await makeOrgWithDomain("Org");
    await queueMessage({ organizationId: org.organizationId, domainId: org.domainId });
    await db.insert(messages).values({
      id: newId("message"),
      organizationId: org.organizationId,
      domainId: org.domainId,
      status: "delivered",
      fromAddress: "hi@example.com",
      recipients: ["person@example.net"],
      subject: "Hi",
      envelope: { from: "hi@example.com", fromName: null, to: ["person@example.net"], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
      tags: [],
    });

    const rows = await listQueueByOrganization();
    const row = rows.find((r) => r.organizationId === org.organizationId);
    expect(row?.depth).toBe(1);
  });
});

describe("listStuckLocks: locked past the lease, and only past the lease", () => {
  it("lists a row locked longer than the lease, with the organization that owns it", async () => {
    const org = await makeOrgWithDomain("Org A");
    const staleLockedAt = new Date(Date.now() - LOCK_TIMEOUT_MS - 60_000);
    const messageId = await queueMessage({
      organizationId: org.organizationId,
      domainId: org.domainId,
      lockedAt: staleLockedAt,
      lockedBy: "worker-dead",
    });

    const stuck = await listStuckLocks();

    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.messageId).toBe(messageId);
    expect(stuck[0]?.organizationId).toBe(org.organizationId);
    expect(stuck[0]?.lockedBy).toBe("worker-dead");
  });

  it("does not list a row locked inside the lease window", async () => {
    const org = await makeOrgWithDomain("Org A");
    await queueMessage({
      organizationId: org.organizationId,
      domainId: org.domainId,
      lockedAt: new Date(),
      lockedBy: "worker-alive",
    });

    expect(await listStuckLocks()).toHaveLength(0);
  });

  it("keeps two organizations' stuck locks separate", async () => {
    const orgA = await makeOrgWithDomain("Org A");
    const orgB = await makeOrgWithDomain("Org B");
    const staleLockedAt = new Date(Date.now() - LOCK_TIMEOUT_MS - 60_000);
    await queueMessage({ organizationId: orgA.organizationId, domainId: orgA.domainId, lockedAt: staleLockedAt, lockedBy: "worker-a" });
    await queueMessage({ organizationId: orgB.organizationId, domainId: orgB.domainId, lockedAt: staleLockedAt, lockedBy: "worker-b" });

    const stuck = await listStuckLocks();
    expect(stuck.map((row) => row.organizationId).sort()).toEqual([orgA.organizationId, orgB.organizationId].sort());
  });
});

describe("readLoopLiveness", () => {
  beforeEach(async () => {
    await db.delete(jobHeartbeats);
  });

  async function age(name: string, ms: number): Promise<void> {
    const at = new Date((await dbNow()).getTime() - ms);
    await db.update(jobHeartbeats).set({ lastBeatAt: at, lastFinishedAt: at, lastStartedAt: at }).where(eq(jobHeartbeats.name, name));
  }

  it("lists every loop the worker runs, never-run rather than stale with nothing yet", async () => {
    const loops = await readLoopLiveness();
    expect(loops.map((loop) => loop.loop).sort()).toEqual([...LOOP_NAMES].sort());
    for (const loop of loops) {
      expect(loop.status).toBe("never");
      expect(loop.lastRunAt).toBeNull();
      expect(loop.intervalMs).toBeNull();
    }
  });

  it("reads a loop that finished clean as ok, and keeps loops separate", async () => {
    await recordJobStart("send", 2000, "worker-1");
    await recordJobFinish("send", null);
    await recordJobStart("verify", 60_000, "worker-1");

    const loops = await readLoopLiveness();
    const byName = (name: string) => loops.find((loop) => loop.loop === name);

    expect(byName("send")?.status).toBe("ok");
    expect(byName("send")?.lastRunAt).not.toBeNull();
    expect(byName("verify")?.status).toBe("ok");
    expect(byName("retention")?.status).toBe("never");
  });

  it("reads a loop whose last run threw as failing, and counts the runs in a row", async () => {
    await recordJobStart("retention", 60_000, "worker-1");
    await recordJobFinish("retention", JOB_ERROR);
    await recordJobStart("retention", 60_000, "worker-1");
    await recordJobFinish("retention", JOB_ERROR);

    const retention = (await readLoopLiveness()).find((loop) => loop.loop === "retention");

    expect(retention?.status).toBe("failing");
    expect(retention?.consecutiveFailures).toBe(2);

    await recordJobStart("retention", 60_000, "worker-1");
    await recordJobFinish("retention", null);
    const recovered = (await readLoopLiveness()).find((loop) => loop.loop === "retention");

    expect(recovered?.status).toBe("ok");
    expect(recovered?.consecutiveFailures).toBe(0);
  });

  it("reads a loop past its own window as stale, however long ago it ran clean", async () => {
    await recordJobStart("retention", 60_000, "worker-1");
    await recordJobFinish("retention", null);
    await recordJobStart("verify", 60_000, "worker-1");
    await recordJobFinish("verify", null);
    await age("retention", 10 * 60_000);
    await age("verify", 2 * 60_000);

    const loops = await readLoopLiveness();

    expect(loops.find((loop) => loop.loop === "retention")?.status).toBe("stale");
    expect(loops.find((loop) => loop.loop === "verify")?.status).toBe("ok");
  });

  it("keeps a long run alive with beats, and reads it stale once they stop", async () => {
    await recordJobStart("export", 5000, "worker-1");
    await age("export", 60_000);
    expect((await readLoopLiveness()).find((loop) => loop.loop === "export")?.status).toBe("stale");

    await recordJobBeat("export");

    expect((await readLoopLiveness()).find((loop) => loop.loop === "export")?.status).toBe("ok");
  });
});

describe("listProviderIdentityRates: grouped by the provider behind the credentials, not the organization row", () => {
  it("merges two organizations' providers that share one provider identity", async () => {
    const orgA = await makeOrg("Org A");
    const orgB = await makeOrg("Org B");
    const providerA = await addProvider(orgA, { identity: "210987654321" });
    const providerB = await addProvider(orgB, { identity: "210987654321" });

    await addDeliveryEvent(orgA, providerA, "delivered");
    await addDeliveryEvent(orgA, providerA, "bounced");
    await addDeliveryEvent(orgB, providerB, "delivered");
    await addDeliveryEvent(orgB, providerB, "complained");

    const groups = await listProviderIdentityRates();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ identity: "210987654321", delivered: 2, bounced: 1, complained: 1 });
    expect(groups[0]?.providerIds.sort()).toEqual([providerA, providerB].sort());
    expect(groups[0]?.organizationNames).toEqual(["Org A", "Org B"]);
  });

  it("never merges two providers whose identity is unknown, even on the same adapter", async () => {
    const org = await makeOrg("Org");
    const providerA = await addProvider(org, { identity: null, name: "one" });
    const providerB = await addProvider(org, { identity: null, name: "two" });
    await addDeliveryEvent(org, providerA, "bounced");
    await addDeliveryEvent(org, providerB, "bounced");

    const groups = await listProviderIdentityRates();
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.identity === null)).toBe(true);
    expect(new Set(groups.map((group) => group.key)).size).toBe(2);
  });

  it("keeps two organizations on different AWS accounts apart", async () => {
    const orgA = await makeOrg("Org A");
    const orgB = await makeOrg("Org B");
    const providerA = await addProvider(orgA, { identity: "111111111111" });
    const providerB = await addProvider(orgB, { identity: "222222222222" });
    await addDeliveryEvent(orgA, providerA, "delivered");
    await addDeliveryEvent(orgB, providerB, "bounced");

    const groups = await listProviderIdentityRates();
    expect(groups).toHaveLength(2);
    const a = groups.find((group) => group.identity === "111111111111");
    const b = groups.find((group) => group.identity === "222222222222");
    expect(a).toMatchObject({ delivered: 1, bounced: 0 });
    expect(b).toMatchObject({ delivered: 0, bounced: 1 });
  });

  it("counts complained and failed outcomes too", async () => {
    const org = await makeOrg("Org");
    const provider = await addProvider(org, { identity: "444444444444" });
    await addDeliveryEvent(org, provider, "delivered");
    await addDeliveryEvent(org, provider, "bounced");
    await addDeliveryEvent(org, provider, "complained");
    await addDeliveryEvent(org, provider, "failed");

    const [group] = await listProviderIdentityRates();
    expect(group).toMatchObject({ delivered: 1, bounced: 1, complained: 1, failed: 1 });
  });

  it("only counts events inside the rate window", async () => {
    const org = await makeOrg("Org");
    const provider = await addProvider(org, { identity: "333333333333" });
    await addDeliveryEvent(org, provider, "delivered");
    const [group] = await listProviderIdentityRates();
    expect(group?.delivered).toBe(1);

    // Push the event outside the window and confirm it drops out.
    await db.update(messageEvents).set({ occurredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }).where(eq(messageEvents.providerId, provider));
    const groups = await listProviderIdentityRates();
    expect(groups[0]?.delivered).toBe(0);
  });
});

describe("readUnconfirmedCluster: a cluster of marks is our ingest, one mark is a provider gap", () => {
  /** Sends in one statement, all at the same `sent_at`, optionally already marked. */
  async function seedSends(options: {
    organizationId: string;
    domainId: string;
    providerId?: string | null;
    count: number;
    sentAt: Date;
    abandonedAt?: Date | null;
  }): Promise<void> {
    if (options.count === 0) return;
    const from = "hi@example.com";
    await db.insert(messages).values(
      Array.from({ length: options.count }, () => ({
        id: newId("message"),
        organizationId: options.organizationId,
        domainId: options.domainId,
        providerId: options.providerId ?? null,
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

  it("counts the window's marks per provider and names the endpoint the events should have reached", async () => {
    const orgA = await makeOrgWithDomain("Org A");
    const orgB = await makeOrgWithDomain("Org B");
    const providerA = await addProvider(orgA.organizationId, { adapter: "ses", name: "a" });
    const providerB = await addProvider(orgB.organizationId, { adapter: "mailpace", name: "b" });
    const now = await dbNow();
    const sentAt = new Date(now.getTime() - ABANDON_MS - 60_000);

    await seedSends({ ...orgA, providerId: providerA, count: 3, sentAt, abandonedAt: now });
    await seedSends({ ...orgB, providerId: providerB, count: 1, sentAt, abandonedAt: now });
    // Marked two windows back: past the window this reports on.
    await seedSends({
      ...orgA,
      providerId: providerA,
      count: 5,
      sentAt: new Date(now.getTime() - 4 * UNCONFIRMED_WINDOW_MS),
      abandonedAt: new Date(now.getTime() - 3 * UNCONFIRMED_WINDOW_MS),
    });

    const view = await readUnconfirmedCluster();

    expect(view.marked).toBe(4);
    const a = view.providers.find((row) => row.providerId === providerA);
    const b = view.providers.find((row) => row.providerId === providerB);
    expect(a?.marked).toBe(3);
    expect(a?.webhookUrl).toBe(webhookUrl("ses", providerA));
    expect(a?.organizationName).toBe("Org A");
    expect(b?.marked).toBe(1);
    expect(b?.webhookUrl).toBe(webhookUrl("mailpace", providerB));
    // Heaviest provider first: it's the one to look at.
    expect(view.providers[0]?.providerId).toBe(providerA);
  });

  it("counts only sends old enough to have been marked in the denominator", async () => {
    const org = await makeOrgWithDomain("Org");
    const provider = await addProvider(org.organizationId, { name: "denominator" });
    const now = await dbNow();

    // Eligible: sent inside the one window that ended when marking became possible.
    await seedSends({ ...org, providerId: provider, count: 2, sentAt: new Date(now.getTime() - ABANDON_MS - 60_000) });
    // Too young to be marked at all.
    await seedSends({ ...org, providerId: provider, count: 7, sentAt: new Date(now.getTime() - 60 * 60 * 1000) });
    // Older than the window the current marks were drawn from.
    await seedSends({
      ...org,
      providerId: provider,
      count: 4,
      sentAt: new Date(now.getTime() - ABANDON_MS - UNCONFIRMED_WINDOW_MS - 60_000),
    });

    const view = await readUnconfirmedCluster();

    expect(view.eligibleSends).toBe(2);
  });

  it("reads as a cluster against the window's sends, and goes quiet as the volume grows", async () => {
    const org = await makeOrgWithDomain("Org");
    const provider = await addProvider(org.organizationId, { name: "cluster" });
    const now = await dbNow();
    const sentAt = new Date(now.getTime() - ABANDON_MS - 60_000);

    await seedSends({ ...org, providerId: provider, count: UNCONFIRMED_CLUSTER_FLOOR, sentAt, abandonedAt: now });
    const clustered = await readUnconfirmedCluster();
    expect(clustered.marked).toBe(UNCONFIRMED_CLUSTER_FLOOR);
    expect(clustered.share).toBe(1);
    expect(clustered.clustered).toBe(true);

    // Same marks, far more sends behind them: a rate this small is normal provider silence.
    const quietVolume = Math.ceil(UNCONFIRMED_CLUSTER_FLOOR / (UNCONFIRMED_CLUSTER_SHARE / 2));
    await seedSends({ ...org, providerId: provider, count: quietVolume, sentAt });
    const quiet = await readUnconfirmedCluster();
    expect(quiet.marked).toBe(UNCONFIRMED_CLUSTER_FLOOR);
    expect(quiet.clustered).toBe(false);
  });

  it("is quiet and empty with nothing marked", async () => {
    const org = await makeOrgWithDomain("Org");
    const provider = await addProvider(org.organizationId, { name: "quiet" });
    const now = await dbNow();
    await seedSends({ ...org, providerId: provider, count: 3, sentAt: new Date(now.getTime() - ABANDON_MS - 60_000) });

    const view = await readUnconfirmedCluster();

    expect(view.marked).toBe(0);
    expect(view.clustered).toBe(false);
    expect(view.providers).toEqual([]);
    expect(view.share).toBe(0);
  });
});
