import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { domainDailyStats } from "@/lib/db/schema";
import { currentWindow } from "@/lib/mail/digest/cadence";
import { readDigestSummary } from "@/lib/mail/digest/metrics";
import { readOrganizationReputation } from "@/lib/reputation/read";
import { readDeliveryShifts } from "@/lib/stats/delivery-time";
import { resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const DAY = 86_400_000;
const NOW = new Date("2026-10-15T12:00:00Z");

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

/** One row a day back from `NOW`: 7 to 14 days back at `baselineMs`, today and the days after at `latestMs`. */
async function seedHistory(latestMs: number, baselineMs = 40_000, target: Pick<Fixture, "organizationId" | "domainId"> = fixture) {
  const rows = Array.from({ length: 15 }, (_, back) => {
    const at = new Date(NOW.getTime() - back * DAY);
    const p90 = back < 7 ? latestMs : baselineMs;
    return {
      organizationId: target.organizationId,
      domainId: target.domainId,
      day: at.toISOString().slice(0, 10),
      computedAt: at,
      deliveryWindowStart: new Date(at.getTime() - 7 * DAY),
      deliveredCount: 500,
      deliveryP90Ms: p90,
      volumeWindowStart: new Date(at.getTime() - 28 * DAY),
      hourlyVolume: Array.from({ length: 24 }, () => 0),
    };
  });
  await db.insert(domainDailyStats).values(rows);
}

describe("readDeliveryShifts", () => {
  it("returns a domain whose latest p90 is well above its own earlier weeks", async () => {
    await seedHistory(240_000);
    const shifts = await readDeliveryShifts({ organizationId: fixture.organizationId }, NOW);
    expect([...shifts.values()]).toEqual([
      { domainId: fixture.domainId, organizationId: fixture.organizationId, p90Ms: 240_000, baselineMs: 40_000, delivered: 500 },
    ]);
  });

  it("returns nothing for a domain at its normal, or another organization's domain", async () => {
    await seedHistory(45_000);
    expect((await readDeliveryShifts({}, NOW)).size).toBe(0);
    await db.delete(domainDailyStats);
    await seedHistory(240_000);
    const other = await seedFixture();
    expect((await readDeliveryShifts({ organizationId: other.organizationId }, NOW)).size).toBe(0);
  });
});

describe("reputation", () => {
  it("puts a slow domain at watch and says why", async () => {
    await seedHistory(240_000);
    const reputation = await readOrganizationReputation(fixture.organizationId, NOW);
    const domain = reputation.domains.get(fixture.domainId);
    expect(domain?.standing).toBe("watch");
    expect(domain?.findings.map((finding) => finding.kind)).toEqual(["delivery_time"]);
  });

  it("stays healthy on a normal day", async () => {
    await seedHistory(45_000);
    expect((await readOrganizationReputation(fixture.organizationId, NOW)).domains.get(fixture.domainId)?.standing).toBe("healthy");
  });
});

describe("digest", () => {
  it("lists a domain whose delivery time ended the window slow", async () => {
    const window = currentWindow("daily", new Date("2026-10-15T00:30:00Z"));
    await seedMessage(fixture, { createdAt: new Date(window.since.getTime() + 3_600_000) });
    await seedHistory(240_000);
    // The window ends on the 14th; the 15th's row is newer and reads normal.
    await db.update(domainDailyStats).set({ deliveryP90Ms: 40_000 }).where(eq(domainDailyStats.day, "2026-10-15"));

    const summary = await readDigestSummary(window);

    expect(summary?.attention.slowDomains).toEqual([
      expect.objectContaining({ domainId: fixture.domainId, p90Ms: 240_000, baselineMs: 40_000 }),
    ]);
  });
});
