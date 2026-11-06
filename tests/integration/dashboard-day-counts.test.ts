import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { activity } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { messageVolume } from "@/lib/dashboard/message-volume";
import { activityByDay, activityWindowStart } from "@/lib/dashboard/activity-days";
import { addDomainKey, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;
const today = NOW.toISOString().slice(0, 10);
const yesterday = new Date(NOW.getTime() - DAY).toISOString().slice(0, 10);

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

function dayOf(days: { day: string }[], day: string) {
  return days.find((entry) => entry.day === day);
}

describe("messageVolume", () => {
  it("counts per day under the list's filters and flags bounced, complained and failed", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    const earlier = new Date(NOW.getTime() - DAY);
    await seedMessage(fixture, { status: "delivered", createdAt: NOW });
    await seedMessage(fixture, { status: "bounced", createdAt: NOW });
    await seedMessage(fixture, { status: "failed", createdAt: earlier });
    await seedMessage(fixture, { status: "complained", createdAt: earlier, apiKeyId: fixture.key.id });
    await seedMessage({ organizationId: fixture.organizationId, domainId: second.domainId }, { status: "bounced", createdAt: NOW });
    const other = await seedFixture();
    await seedMessage(other, { status: "bounced", createdAt: NOW });

    const all = await messageVolume(fixture.organizationId, {}, "UTC", NOW);
    expect(all).toHaveLength(8);
    expect(dayOf(all, today)).toMatchObject({ total: 3, flagged: 2 });
    expect(dayOf(all, yesterday)).toMatchObject({
      total: 2,
      flagged: 2,
      breakdown: [
        ["complained", 1],
        ["failed", 1],
      ],
    });

    const scoped = await messageVolume(fixture.organizationId, { domain: "second.example.com" }, "UTC", NOW);
    expect(dayOf(scoped, today)).toMatchObject({ total: 1, flagged: 1 });
    expect(dayOf(scoped, yesterday)).toMatchObject({ total: 0, flagged: 0 });

    const byKey = await messageVolume(fixture.organizationId, { keyId: fixture.key.id }, "UTC", NOW);
    expect(byKey.reduce((sum, day) => sum + day.total, 0)).toBe(1);

    const delivered = await messageVolume(fixture.organizationId, { statuses: ["delivered"] }, "UTC", NOW);
    expect(dayOf(delivered, today)).toMatchObject({ total: 1, flagged: 0 });
  });

  it("reaches back as far as the list's window", async () => {
    await seedMessage(fixture, { createdAt: new Date(NOW.getTime() - 20 * DAY) });
    expect((await messageVolume(fixture.organizationId, {}, "UTC", NOW)).reduce((sum, day) => sum + day.total, 0)).toBe(0);
    const wide = await messageVolume(fixture.organizationId, { since: new Date(NOW.getTime() - 30 * DAY) }, "UTC", NOW);
    expect(wide).toHaveLength(31);
    expect(wide.reduce((sum, day) => sum + day.total, 0)).toBe(1);
  });
});

describe("activityByDay", () => {
  async function insert(organizationId: string, action: string, family: "key" | "session", outcome: "success" | "failure", createdAt: Date) {
    await db.insert(activity).values({
      id: newId("activity"),
      organizationId,
      action,
      family,
      outcome,
      actorType: "worker",
      actorId: null,
      actorLabel: "Pouch",
      createdAt,
    });
  }

  it("counts per day under the screen's filters and flags failures", async () => {
    await insert(fixture.organizationId, "key.created", "key", "success", NOW);
    await insert(fixture.organizationId, "session.sign_in.failed", "session", "failure", NOW);
    await insert(fixture.organizationId, "key.created", "key", "success", new Date(NOW.getTime() - DAY));
    await insert(fixture.organizationId, "key.created", "key", "success", new Date(NOW.getTime() - 40 * DAY));
    const other = await seedFixture();
    await insert(other.organizationId, "key.created", "key", "success", NOW);

    const filters = { families: [], outcomes: [], actors: [], since: null };
    const days = await activityByDay(fixture.organizationId, filters, "UTC", NOW);
    expect(days).toHaveLength(30);
    expect(dayOf(days, today)).toMatchObject({ total: 2, flagged: 1 });
    expect(dayOf(days, yesterday)).toMatchObject({ total: 1, flagged: 0 });
    expect(days.reduce((sum, day) => sum + day.total, 0)).toBe(3);

    const keys = await activityByDay(fixture.organizationId, { ...filters, families: ["key" as const] }, "UTC", NOW);
    expect(dayOf(keys, today)).toMatchObject({ total: 1, flagged: 0 });

    const failures = await activityByDay(fixture.organizationId, { ...filters, outcomes: ["failure" as const] }, "UTC", NOW);
    expect(failures.reduce((sum, day) => sum + day.total, 0)).toBe(1);
  });
});

describe("days in a viewer's zone", () => {
  const LA = "America/Los_Angeles";
  // 05:00 PDT on October 1.
  const AT = new Date("2026-10-01T12:00:00.000Z");

  it("buckets 23:30 UTC and the small hours after it on the Los Angeles day they happened", async () => {
    // 16:30 and 20:30 PDT on September 29; UTC splits them across two days.
    await seedMessage(fixture, { status: "delivered", createdAt: new Date("2026-09-29T23:30:00.000Z") });
    await seedMessage(fixture, { status: "bounced", createdAt: new Date("2026-09-30T03:30:00.000Z") });

    const local = await messageVolume(fixture.organizationId, {}, LA, AT);
    expect(dayOf(local, "2026-09-29")).toMatchObject({ total: 2, flagged: 1 });
    expect(dayOf(local, "2026-09-30")).toMatchObject({ total: 0 });
    expect(local.at(-1)?.day).toBe("2026-10-01");

    const utc = await messageVolume(fixture.organizationId, {}, "UTC", AT);
    expect(dayOf(utc, "2026-09-29")).toMatchObject({ total: 1, flagged: 0 });
    expect(dayOf(utc, "2026-09-30")).toMatchObject({ total: 1, flagged: 1 });
  });

  it("starts the activity window at local midnight", async () => {
    const filters = { families: [], outcomes: [], actors: [], since: null };
    expect(activityWindowStart(filters, LA, AT).toISOString()).toBe("2026-09-02T07:00:00.000Z");
    expect(activityWindowStart(filters, "UTC", AT).toISOString()).toBe("2026-09-02T00:00:00.000Z");

    await db.insert(activity).values({
      id: newId("activity"),
      organizationId: fixture.organizationId,
      action: "key.created",
      family: "key",
      outcome: "success",
      actorType: "worker",
      actorId: null,
      actorLabel: "Pouch",
      createdAt: new Date("2026-10-01T02:00:00.000Z"),
    });
    const days = await activityByDay(fixture.organizationId, filters, LA, AT);
    expect(days).toHaveLength(30);
    expect(dayOf(days, "2026-09-30")).toMatchObject({ total: 1 });
  });
});
