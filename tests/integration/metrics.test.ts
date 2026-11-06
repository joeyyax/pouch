import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { domains, messageEvents, messages, organizations, providers } from "@/lib/db/schema";
import type { MessageStatus } from "@/lib/db/schema";
import { readOverview } from "@/lib/dashboard/metrics";
import { encryptCredentials } from "@/lib/providers";
import { newId } from "@/lib/ids";
import { resolved } from "@/lib/metrics/rates";
import { rollupMessageStats } from "@/lib/stats/rollup";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

const NOW = new Date("2026-09-08T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

interface SeedMessage {
  status?: MessageStatus;
  /** How long before NOW the message was accepted. */
  agoMs?: number;
  /** Time spent in the queue before it was handed over. */
  queueMs?: number | null;
  /** Time from handover to delivery. */
  providerMs?: number | null;
  attempts?: number;
  domainId?: string;
  nextAttemptAt?: Date;
  lockedAt?: Date | null;
  abandonedAt?: Date | null;
}

async function seedMessage(options: SeedMessage = {}): Promise<string> {
  const {
    status = "delivered",
    agoMs = 2 * DAY,
    queueMs = 400,
    providerMs = 2000,
    attempts = 1,
    domainId = fixture.domainId,
    nextAttemptAt,
    lockedAt = null,
    abandonedAt = null,
  } = options;

  const id = newId("message");
  const createdAt = new Date(NOW.getTime() - agoMs);
  const sentAt = queueMs === null ? null : new Date(createdAt.getTime() + queueMs);
  const deliveredAt = sentAt && providerMs !== null ? new Date(sentAt.getTime() + providerMs) : null;

  await db.insert(messages).values({
    id,
    organizationId: fixture.organizationId,
    domainId,
    status,
    fromAddress: "ada@example.com",
    recipients: ["person@example.net"],
    subject: "Hello",
    envelope: {
      from: "ada@example.com",
      fromName: null,
      to: ["person@example.net"],
      cc: [],
      bcc: [],
      replyTo: [],
      headers: {},
      attachmentCount: 0,
    },
    attempts,
    createdAt,
    sentAt,
    deliveredAt,
    nextAttemptAt: nextAttemptAt ?? createdAt,
    lockedAt,
    abandonedAt,
  });
  return id;
}

async function seedBounceReason(
  reason: string,
  { testMode = false, domainId }: { testMode?: boolean; domainId?: string } = {},
): Promise<string> {
  const messageId = await seedMessage({ status: "bounced", providerMs: null, domainId });
  if (testMode) await db.update(messages).set({ testMode: true }).where(eq(messages.id, messageId));
  await db.insert(messageEvents).values({
    id: newId("event"),
    organizationId: fixture.organizationId,
    messageId,
    status: "bounced",
    reason,
    detail: {},
    occurredAt: new Date(NOW.getTime() - DAY),
  });
  return messageId;
}

/** A second domain, so the per-domain rollup has something to separate. */
async function seedDomain(name: string): Promise<string> {
  const id = newId("domain");
  await db.insert(domains).values({
    id,
    organizationId: fixture.organizationId,
    providerId: fixture.providerId,
    name,
    status: "verified",
    verifiedAt: NOW,
  });
  return id;
}

describe("an organization that has never sent", () => {
  it("says so, rather than showing a wall of zeroes as if they meant something", async () => {
    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.everSent).toBe(false);
    expect(overview.counts.total).toBe(0);
    expect(overview.conditions).toEqual([]);
  });

  it("counts test sends as sent but not as live", async () => {
    const id = await seedMessage({ agoMs: 2 * DAY });
    await db.update(messages).set({ testMode: true }).where(eq(messages.id, id));

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.everSent).toBe(true);
    expect(overview.everSentLive).toBe(false);
    expect(overview.counts.total).toBe(0);
  });

  it("reads live once a live message exists", async () => {
    await seedMessage({ agoMs: 2 * DAY });

    expect((await readOverview(fixture.organizationId, 30, "UTC", NOW)).everSentLive).toBe(true);
  });
});

describe("the window", () => {
  it("counts only messages inside it", async () => {
    await seedMessage({ agoMs: 2 * DAY });
    await seedMessage({ agoMs: 40 * DAY });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.counts.total).toBe(1);
    expect(overview.everSent).toBe(true);
  });

  it("puts the previous window's messages in the comparison, not the current one", async () => {
    await seedMessage({ agoMs: 2 * DAY });
    await seedMessage({ agoMs: 40 * DAY });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.counts.total).toBe(1);
    expect(overview.previousCounts.total).toBe(1);
  });

  it("has a bar for every day, including days nothing was sent", async () => {
    await seedMessage({ agoMs: 2 * DAY });

    const overview = await readOverview(fixture.organizationId, 7, "UTC", NOW);

    expect(overview.volume).toHaveLength(8);
    expect(overview.volume.filter((day) => day.delivered > 0)).toHaveLength(1);
  });

  it("buckets the 24-hour window by hour in the viewer's zone, with the domain trend on the same buckets", async () => {
    await seedMessage({ agoMs: 3 * HOUR - 10 * 60_000 });
    await seedMessage({ agoMs: 3 * HOUR - 20 * 60_000, status: "bounced" });
    await seedMessage({ agoMs: 30 * HOUR });

    const overview = await readOverview(fixture.organizationId, 1, "America/New_York", NOW);
    const busy = overview.volume.filter((hour) => hour.delivered + hour.bounced > 0);

    expect(overview.volume.length).toBeGreaterThanOrEqual(24);
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({ delivered: 1, bounced: 1, label: expect.stringMatching(/^\d\d:00$/) });
    expect(overview.domains[0]?.daily).toHaveLength(overview.volume.length);
    expect(overview.previousVolume.reduce((sum, hour) => sum + hour.delivered, 0)).toBe(1);
  });

  it("lines the previous window up with this one, day for day", async () => {
    await seedMessage({ agoMs: 2 * DAY });
    await seedMessage({ agoMs: 9 * DAY, status: "bounced" });

    const overview = await readOverview(fixture.organizationId, 7, "UTC", NOW);

    expect(overview.previousVolume).toHaveLength(overview.volume.length);
    expect(overview.previousVolume.findIndex((day) => day.bounced > 0)).toBe(
      overview.volume.findIndex((day) => day.delivered > 0),
    );
    expect(overview.previousVolume.reduce((sum, day) => sum + day.delivered, 0)).toBe(0);
  });
});

describe("the denominator", () => {
  it("leaves in-flight messages out, so a window ending now isn't punished for them", async () => {
    for (let i = 0; i < 10; i += 1) await seedMessage({ status: "delivered" });
    for (let i = 0; i < 90; i += 1) await seedMessage({ status: "sent", providerMs: null });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.counts.total).toBe(100);
    expect(overview.counts.inFlight).toBe(90);
    expect(resolved(overview.counts)).toBe(10);
  });
});

describe("latency", () => {
  it("measures the queue from accepted to handed over", async () => {
    for (let i = 0; i < 40; i += 1) await seedMessage({ queueMs: 500, providerMs: 4000 });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.queueLatency.count).toBe(40);
    expect(overview.queueLatency.p50).toBeCloseTo(500, 0);
  });

  it("measures the provider separately, which is what says whose problem it is", async () => {
    for (let i = 0; i < 40; i += 1) await seedMessage({ queueMs: 500, providerMs: 4000 });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.providerLatency.p50).toBeCloseTo(4000, 0);
    expect(overview.endToEndLatency.p50).toBeCloseTo(4500, 0);
  });

  it("returns numbers, not the strings the driver hands back for a numeric", async () => {
    for (let i = 0; i < 40; i += 1) await seedMessage();

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(typeof overview.queueLatency.p95).toBe("number");
    expect(typeof overview.queue.retryPressure).toBe("number");
  });

  it("has nothing to report when no message got far enough to measure", async () => {
    await seedMessage({ status: "queued", queueMs: null });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.queueLatency.count).toBe(0);
    expect(overview.queueLatency.p50).toBeNull();
  });
});

describe("the queue reading", () => {
  it("separates what's waiting on us from what's backing off", async () => {
    await seedMessage({ status: "queued", queueMs: null, agoMs: 5 * MINUTE });
    await seedMessage({
      status: "queued",
      queueMs: null,
      agoMs: 5 * MINUTE,
      nextAttemptAt: new Date(NOW.getTime() + 10 * MINUTE),
    });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.queue.due).toBe(1);
    expect(overview.queue.backingOff).toBe(1);
  });

  it.each([
    [
      "held by its shared provider's backoff as backing off",
      async () => {
        const sharedId = newId("provider");
        await db.insert(providers).values({
          id: sharedId,
          adapter: "mock",
          name: "Hosted",
          credentials: encryptCredentials({ serverToken: "shared" }),
          shared: true,
          backoffUntil: new Date(NOW.getTime() + 10 * MINUTE),
        });
        await db.update(providers).set({ sharedProviderId: sharedId }).where(eq(providers.id, fixture.providerId));
      },
      { due: 0, backingOff: 1 },
    ],
    [
      "held by its own provider's backoff as backing off",
      async () => {
        await db
          .update(providers)
          .set({ backoffUntil: new Date(NOW.getTime() + 10 * MINUTE) })
          .where(eq(providers.id, fixture.providerId));
      },
      { due: 0, backingOff: 1 },
    ],
    [
      "as due once its provider's backoff has passed",
      async () => {
        await db
          .update(providers)
          .set({ backoffUntil: new Date(NOW.getTime() - MINUTE) })
          .where(eq(providers.id, fixture.providerId));
      },
      { due: 1, backingOff: 0 },
    ],
  ])("counts a message %s", async (_name, setup, expected) => {
    await setup();
    await seedMessage({ status: "queued", queueMs: null, agoMs: 5 * MINUTE });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.queue.due).toBe(expected.due);
    expect(overview.queue.backingOff).toBe(expected.backingOff);
    if (expected.due === 0) expect(overview.queue.oldestDueMs).toBeNull();
  });

  it("counts a message held by its domain's stall as held, not due", async () => {
    await db
      .update(domains)
      .set({
        stalledAt: NOW,
        stallReason: "bounce_rate",
        stallDetail: { metric: "bounce", count: 10, denominator: 20, rate: 0.5, previousRate: 0.4, threshold: 0.1 },
      })
      .where(eq(domains.id, fixture.domainId));
    await seedMessage({ status: "queued", queueMs: null, agoMs: 20 * MINUTE });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.queue.due).toBe(0);
    expect(overview.queue.backingOff).toBe(0);
    expect(overview.queue.held).toBe(1);
    expect(overview.queue.heldByDomain).toEqual([{ domainId: fixture.domainId, count: 1, oldestMs: 20 * MINUTE }]);
    expect(overview.queue.oldestDueMs).toBeNull();
  });

  it("counts a message held by a reputation suspension as held, not due", async () => {
    await db
      .update(organizations)
      .set({
        suspendedAt: NOW,
        suspendReason: "bounce rate",
        suspendSource: "reputation",
        suspendDetail: { reason: "bounce_rate", metric: "bounce_rate", count: 10 },
      })
      .where(eq(organizations.id, fixture.organizationId));
    await seedMessage({ status: "queued", queueMs: null, agoMs: 20 * MINUTE });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.queue.due).toBe(0);
    expect(overview.queue.backingOff).toBe(0);
    expect(overview.queue.held).toBe(1);
    expect(overview.queue.oldestDueMs).toBeNull();
  });

  it("counts messages held by a provider suspension as held, and ages the oldest", async () => {
    await db
      .update(organizations)
      .set({ suspendedAt: NOW, suspendReason: "The email provider paused sending.", suspendSource: "provider" })
      .where(eq(organizations.id, fixture.organizationId));
    await seedMessage({ status: "queued", queueMs: null, agoMs: 3 * DAY });
    await seedMessage({ status: "queued", queueMs: null, agoMs: 5 * MINUTE });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.queue.due).toBe(0);
    expect(overview.queue.backingOff).toBe(0);
    expect(overview.queue.held).toBe(2);
    expect(overview.queue.organizationHeld).toBe(true);
    expect(overview.queue.oldestHeldMs).toBe(3 * DAY);
    expect(overview.conditions.find((condition) => condition.key === "held")?.title).toBe("Held mail is 3 days old");
    expect(overview.queue.oldestDueMs).toBeNull();
  });

  it("has no held age when nothing is held", async () => {
    await seedMessage({ status: "queued", queueMs: null, agoMs: 5 * MINUTE });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.queue.held).toBe(0);
    expect(overview.queue.organizationHeld).toBe(false);
    expect(overview.queue.oldestHeldMs).toBeNull();
    expect(overview.conditions.map((condition) => condition.key)).not.toContain("held");
  });

  it("doesn't hold the queue for a suspension source that fails sends instead", async () => {
    await db
      .update(organizations)
      .set({ suspendedAt: NOW, suspendReason: "manual review", suspendSource: "manual" })
      .where(eq(organizations.id, fixture.organizationId));
    await seedMessage({ status: "queued", queueMs: null, agoMs: 5 * MINUTE });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.queue.due).toBe(1);
    expect(overview.queue.held).toBe(0);
    expect(overview.queue.organizationHeld).toBe(false);
    expect(overview.queue.organizationFails).toBe(true);
    expect(overview.conditions.find((condition) => condition.key === "backlog")?.title).toBe("Queued mail will fail");
  });

  it("ages the oldest due message, since depth on its own says nothing", async () => {
    await seedMessage({ status: "queued", queueMs: null, agoMs: 20 * MINUTE });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.queue.oldestDueMs).toBeGreaterThanOrEqual(20 * MINUTE);
    expect(overview.conditions.map((condition) => condition.key)).toContain("backlog");
  });

  it("counts messages the provider took and went quiet about", async () => {
    await seedMessage({ status: "sent", agoMs: 3 * 3_600_000, queueMs: 500, providerMs: null });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.queue.silent).toBe(1);
    expect(overview.conditions.map((condition) => condition.key)).toContain("accepted_silent");
  });

  it("excludes a message the abandon sweep has already marked, from silent and from in flight", async () => {
    await seedMessage({
      status: "sent",
      agoMs: 3 * 3_600_000,
      queueMs: 500,
      providerMs: null,
      abandonedAt: new Date(NOW.getTime() - 3_600_000),
    });
    await seedMessage({ status: "sent", agoMs: 10 * 60_000, queueMs: 500, providerMs: null });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.queue.silent).toBe(0);
    expect(overview.conditions.map((condition) => condition.key)).not.toContain("accepted_silent");
    expect(overview.counts.inFlight).toBe(1);
  });

  it("stops counting a silent message once it's old enough the sweep would have caught it", async () => {
    // Sent well past ABANDON_MS and never marked — the production bug this guards against: a
    // sweep that never ran, or a row it missed, shouldn't pin the warning forever.
    await seedMessage({ status: "sent", agoMs: 30 * DAY, queueMs: 500, providerMs: null });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.queue.silent).toBe(0);
    expect(overview.conditions.map((condition) => condition.key)).not.toContain("accepted_silent");
  });

  it("reads the queue as it is now, not as it was over the window", async () => {
    // Old enough to fall outside every window, and still queued.
    await seedMessage({ status: "queued", queueMs: null, agoMs: 200 * DAY });

    const overview = await readOverview(fixture.organizationId, 7, "UTC", NOW);

    expect(overview.counts.total).toBe(0);
    expect(overview.queue.due).toBe(1);
  });
});

describe("by domain", () => {
  it("splits the counts per domain", async () => {
    const other = await seedDomain("example.net");
    await seedMessage();
    await seedMessage({ domainId: other });
    await seedMessage({ domainId: other });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.domains.map((row) => [row.domainName, row.counts.total])).toEqual([
      ["example.net", 2],
      ["example.com", 1],
    ]);
  });

  it("keeps a domain that sent last window and nothing this one", async () => {
    await seedMessage({ agoMs: 40 * DAY });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.domains).toHaveLength(1);
    expect(overview.domains[0]?.counts.total).toBe(0);
    expect(overview.domains[0]?.daily.every((count) => count === 0)).toBe(true);
    expect(overview.conditions).toEqual([]);
  });

  it("gives each domain a day-by-day count aligned with the volume bars", async () => {
    await seedMessage({ agoMs: 2 * DAY });
    await seedMessage({ agoMs: 2 * DAY });

    const overview = await readOverview(fixture.organizationId, 7, "UTC", NOW);
    const daily = overview.domains[0]?.daily ?? [];

    expect(daily).toHaveLength(overview.volume.length);
    expect(daily.reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(daily.findIndex((count) => count > 0)).toBe(overview.volume.findIndex((day) => day.delivered > 0));
  });
});

/** `perDay` delivered messages in each of the 14 days before the last one, and `lastDay` in it. */
async function seedVolume(domainId: string, perDay: number, lastDay: number): Promise<void> {
  const rows: (typeof messages.$inferInsert)[] = [];
  const spread = (day: number, count: number) => {
    for (let index = 0; index < count; index += 1) {
      const createdAt = new Date(NOW.getTime() - day * DAY - ((index + 0.5) / count) * 23 * HOUR);
      rows.push({
        id: newId("message"),
        organizationId: fixture.organizationId,
        domainId,
        status: "delivered",
        fromAddress: "ada@example.com",
        recipients: ["person@example.net"],
        subject: "Hello",
        envelope: { from: "ada@example.com", fromName: null, to: ["person@example.net"], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
        attempts: 1,
        createdAt,
        sentAt: createdAt,
        deliveredAt: createdAt,
        nextAttemptAt: createdAt,
      });
    }
  };
  for (let day = 1; day <= 14; day += 1) spread(day, perDay);
  spread(0, lastDay);
  for (let at = 0; at < rows.length; at += 500) await db.insert(messages).values(rows.slice(at, at + 500));
}

describe("volume against the last two weeks", () => {
  it("reads the baseline from the rollup and flags a busy domain that stopped, not a quiet one", async () => {
    const quiet = await seedDomain("example.net");
    await seedVolume(fixture.domainId, 60, 0);
    await seedVolume(quiet, 3, 0);
    await rollupMessageStats(NOW);

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.conditions).toEqual([
      expect.objectContaining({
        key: "domain_volume",
        tone: "info",
        title: "example.com stopped sending",
        body: "None sent in the last day, against about 60 a day over the previous 14 days.",
      }),
    ]);
  });

  it("compares the last day at the same hours, counted live", async () => {
    await seedVolume(fixture.domainId, 60, 250);
    await rollupMessageStats(NOW);

    const overview = await readOverview(fixture.organizationId, 7, "UTC", NOW);

    const volume = overview.conditions.filter((condition) => condition.key === "domain_volume");
    expect(volume.map((condition) => condition.title)).toEqual(["example.com is sending more"]);
  });
});

describe("bounce reasons", () => {
  it("groups the provider's words verbatim, most common first", async () => {
    await seedBounceReason("550 5.1.1 user unknown");
    await seedBounceReason("550 5.1.1 user unknown");
    const only = await seedBounceReason("552 mailbox full");

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.bounceReasons).toEqual([
      {
        reason: "550 5.1.1 user unknown",
        count: 2,
        href: "/messages?domain=example.com&status=bounced&reason=550+5.1.1+user+unknown&days=30",
      },
      { reason: "552 mailbox full", count: 1, href: `/messages/${only}` },
    ]);
  });

  it("leaves the domain off a reason more than one domain got", async () => {
    const other = await seedDomain("example.net");
    await seedBounceReason("554 policy");
    await seedBounceReason("554 policy", { domainId: other });

    const overview = await readOverview(fixture.organizationId, 7, "UTC", NOW);

    expect(overview.bounceReasons[0]?.href).toBe("/messages?status=bounced&reason=554+policy&days=7");
  });

  it("leaves test-mode bounces out, as the rest of the overview does", async () => {
    const live = await seedBounceReason("550 5.1.1 user unknown");
    await seedBounceReason("550 5.1.1 user unknown", { testMode: true });
    await seedBounceReason("simulated bounce", { testMode: true });

    const overview = await readOverview(fixture.organizationId, 30, "UTC", NOW);

    expect(overview.bounceReasons).toEqual([{ reason: "550 5.1.1 user unknown", count: 1, href: `/messages/${live}` }]);
  });
});

describe("organization scoping", () => {
  it("never counts another organization's mail", async () => {
    await seedMessage();
    const other = await seedFixture();

    const overview = await readOverview(other.organizationId, 30, "UTC", NOW);

    expect(overview.counts.total).toBe(0);
    expect(overview.everSent).toBe(false);
    expect(overview.domains).toEqual([]);
  });
});
