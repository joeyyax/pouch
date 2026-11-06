import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bulkFanoutRecipients, domainDailyStats, recipientHistory } from "@/lib/db/schema";
import type { DomainDailyStatsRow } from "@/lib/db/schema";
import { dbNow } from "@/lib/db/clock";
import { computeDomainStats, latestDomainStats, pruneDomainStats, utcDay } from "@/lib/domains/daily-stats";
import { readMessage } from "@/lib/dashboard/messages";
import { sha256 } from "@/lib/crypto";
import { addDomainKey, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let fixture: Fixture;
let now: Date;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  now = await dbNow();
});

/** The UTC hour boundary `hoursAgo` before now, plus a minute. */
function hourAgo(hoursAgo: number): Date {
  const at = new Date(now.getTime() - hoursAgo * HOUR);
  at.setUTCMinutes(1, 0, 0);
  return at;
}

async function sent(target: Pick<Fixture, "organizationId" | "domainId">, sentAt: Date, deliveryMs: number | null, testMode = false) {
  return seedMessage(target, {
    createdAt: new Date(sentAt.getTime() - 1000),
    sentAt,
    deliveredAt: deliveryMs === null ? null : new Date(sentAt.getTime() + deliveryMs),
    status: deliveryMs === null ? "sent" : "delivered",
    testMode,
  });
}

describe("computeDomainStats", () => {
  it("rolls delivery quantiles over 7 days and hourly volume over 28, per domain, without test mode", async () => {
    const at = hourAgo(3);
    await Promise.all(Array.from({ length: 100 }, (_, i) => sent(fixture, at, (i + 1) * 100)));
    await sent(fixture, at, 9_000_000, true);
    const older = new Date(now.getTime() - 10 * DAY);
    await sent(fixture, older, 50);
    await sent(fixture, new Date(now.getTime() - 30 * DAY), 50);
    const second = await addDomainKey(fixture);
    await sent({ organizationId: fixture.organizationId, domainId: second.domainId }, at, 400);

    expect(await computeDomainStats(now)).toBe(2);

    const row = await latestDomainStats(fixture.organizationId, fixture.domainId);
    expect(row).toMatchObject({
      day: utcDay(now),
      deliveredCount: 100,
      deliveryMinMs: 100,
      deliveryP50Ms: 5050,
      deliveryP90Ms: 9010,
      deliveryMaxMs: 10_000,
    });
    expect(row?.hourlyVolume).toHaveLength(24);
    expect(row?.hourlyVolume[at.getUTCHours()]).toBe(100);
    expect(row?.hourlyVolume.reduce((sum, n) => sum + n, 0)).toBe(101);

    expect(await latestDomainStats(fixture.organizationId, second.domainId)).toMatchObject({ deliveredCount: 1, deliveryMaxMs: 400 });
  });

  it("rewrites today's row on a rerun", async () => {
    await sent(fixture, hourAgo(2), 1000);
    await computeDomainStats(now);
    await sent(fixture, hourAgo(1), 3000);
    await computeDomainStats(new Date(now.getTime() + 1000));

    const rows = await db.select().from(domainDailyStats).where(eq(domainDailyStats.domainId, fixture.domainId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deliveredCount: 2, deliveryMaxMs: 3000 });
  });

  it("writes no row for a domain with nothing sent in 28 days", async () => {
    await sent(fixture, new Date(now.getTime() - 29 * DAY), 1000);
    expect(await computeDomainStats(now)).toBe(0);
    expect(await latestDomainStats(fixture.organizationId, fixture.domainId)).toBeNull();
  });

  it("drops rows older than 90 days and reads the newest", async () => {
    await sent(fixture, hourAgo(2), 1000);
    await computeDomainStats(now);
    const [today] = await db.select().from(domainDailyStats);
    for (const daysAgo of [91, 89]) {
      await db.insert(domainDailyStats).values({ ...(today as DomainDailyStatsRow), day: utcDay(new Date(now.getTime() - daysAgo * DAY)) });
    }

    expect(await pruneDomainStats(now)).toBe(1);
    const days = await db.select({ day: domainDailyStats.day }).from(domainDailyStats);
    expect(days.map((row) => row.day).sort()).toEqual([utcDay(new Date(now.getTime() - 89 * DAY)), utcDay(now)]);
    expect((await latestDomainStats(fixture.organizationId, fixture.domainId))?.day).toBe(utcDay(now));
  });

  it("never returns a row to another organization", async () => {
    const other = await seedFixture();
    await sent(fixture, hourAgo(2), 1000);
    await computeDomainStats(now);
    expect(await latestDomainStats(other.organizationId, fixture.domainId)).toBeNull();
  });
});

describe("readMessage facts", () => {
  const address = "first@example.net";

  async function message(organizationId = fixture.organizationId) {
    const sentAt = new Date(now.getTime() - 30 * 1000);
    return seedMessage(
      { organizationId, domainId: fixture.domainId },
      {
        to: address,
        apiKeyId: fixture.key.id,
        bodyHash: "body",
        createdAt: new Date(sentAt.getTime() - 1000),
        sentAt,
        deliveredAt: new Date(sentAt.getTime() + 200),
      },
    );
  }

  async function stats(organizationId: string) {
    await db.insert(domainDailyStats).values({
      organizationId,
      domainId: fixture.domainId,
      day: utcDay(now),
      computedAt: new Date(now.getTime() - 60 * 1000),
      deliveryWindowStart: new Date(now.getTime() - 7 * DAY),
      deliveredCount: 500,
      deliveryMinMs: 100,
      deliveryP10Ms: 1000,
      deliveryP25Ms: 2000,
      deliveryP50Ms: 3000,
      deliveryP75Ms: 4000,
      deliveryP90Ms: 6000,
      deliveryP99Ms: 20_000,
      deliveryMaxMs: 60_000,
      volumeWindowStart: new Date(now.getTime() - 28 * DAY),
      hourlyVolume: Array.from({ length: 24 }, () => 20),
    });
  }

  it("reads the recipient's history, the body's fan-out and the domain's stats", async () => {
    const id = await message();
    await db.insert(recipientHistory).values({ organizationId: fixture.organizationId, address, firstSeenAt: new Date(now.getTime() - 31 * 1000) });
    await db.insert(bulkFanoutRecipients).values(
      Array.from({ length: 312 }, (_, i) => ({
        organizationId: fixture.organizationId,
        apiKeyId: fixture.key.id,
        bodyHash: "body",
        day: utcDay(now),
        recipientHash: sha256(`r${i}@example.net`),
      })),
    );
    await stats(fixture.organizationId);

    const detail = await readMessage(fixture.organizationId, id);
    expect(detail?.facts.map((fact) => fact.text)).toEqual([
      "Delivered in 0.2 seconds, faster than 98% of example.com’s mail this week.",
      "The same body went to 312 people from this key today.",
    ]);
  });

  it("ignores another organization's history and stats", async () => {
    const other = await seedFixture();
    const id = await message();
    await db.insert(recipientHistory).values({ organizationId: other.organizationId, address, firstSeenAt: now, bounceCount: 4 });
    await stats(other.organizationId);

    const detail = await readMessage(fixture.organizationId, id);
    expect(detail?.facts.map((fact) => fact.text)).toEqual(["Delivered 0.2 seconds after it sent."]);
  });
});
