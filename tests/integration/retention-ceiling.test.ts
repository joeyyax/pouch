import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, organizations } from "@/lib/db/schema";
import { adminActor } from "@/lib/activity/record";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { newMessageKey } from "@/lib/crypto";
import { retentionDaysFor } from "@/lib/organizations";
import { setSetting } from "@/lib/settings/values";
import { newStorageKey } from "@/lib/storage/bodies";
import { GET as organizationGET, PATCH as organizationPATCH } from "@/app/api/v1/organization/route";
import { RetentionLoop } from "@/worker/retention";
import { apiRequest, messageRow, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const DAY = 24 * 60 * 60 * 1000;
const ADMIN = adminActor("usr_admin", "Admin");

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function setRetentionDays(days: number): Promise<void> {
  await db.update(organizations).set({ bodyRetentionDays: days }).where(eq(organizations.id, fixture.organizationId));
}

async function messageFrom(daysAgo: number): Promise<string> {
  return seedMessage(fixture, {
    id: `msg_${Math.random().toString(36).slice(2, 26).padEnd(24, "0").slice(0, 24)}`,
    subject: "Row",
    to: "you@example.net",
    storageKey: newStorageKey(),
    bodyKey: newMessageKey().encoded,
    createdAt: new Date(Date.now() - daysAgo * DAY),
  });
}

function sweep() {
  return new RetentionLoop({ intervalMs: 60_000, batchSize: 100 }).tick();
}

async function patchRetention(days: number): Promise<{ status: number; body: { body_retention_days?: number; error?: { code: string; field?: string } } }> {
  const response = await organizationPATCH(apiRequest(fixture.secret, "/v1/organization", "PATCH", { body_retention_days: days }));
  return { status: response.status, body: await response.json() };
}

describe("the retention sweep under a ceiling", () => {
  it("shreds at the ceiling when it's below the organization's setting, and leaves the setting alone", async () => {
    await setRetentionDays(90);
    const id = await messageFrom(40);

    expect((await sweep()).shredded).toBe(0);

    await setSetting("body_retention_max_days", 30, ADMIN);
    expect((await sweep()).shredded).toBe(1);
    expect((await messageRow(id)).bodyKey).toBeNull();

    const [org] = await db.select().from(organizations).where(eq(organizations.id, fixture.organizationId));
    expect(org?.bodyRetentionDays).toBe(90);
    expect(await retentionDaysFor(fixture.organizationId)).toBe(30);
  });

  it("follows the environment over the stored ceiling", async () => {
    await setRetentionDays(90);
    await messageFrom(40);
    vi.stubEnv("BODY_RETENTION_MAX_DAYS", "30");
    expect((await sweep()).shredded).toBe(1);
  });
});

describe("PATCH /v1/organization", () => {
  it("refuses a retention above the live ceiling and takes one at it", async () => {
    await setSetting("body_retention_max_days", 30, ADMIN);

    expect(await patchRetention(31)).toMatchObject({ status: 422, body: { error: { code: "validation_failed", field: "body_retention_days" } } });
    expect(await patchRetention(30)).toMatchObject({ status: 200, body: { body_retention_days: 30 } });
  });

  it("takes up to 365 by default, and more once the ceiling is raised", async () => {
    expect((await patchRetention(366)).status).toBe(422);
    await setSetting("body_retention_max_days", 500, ADMIN);
    expect((await patchRetention(366)).status).toBe(200);
  });

  it("reads back the ceiling with the organization", async () => {
    await setSetting("body_retention_max_days", 120, ADMIN);
    const response = await organizationGET(apiRequest(fixture.secret, "/v1/organization"));
    expect(await response.json()).toMatchObject({ body_retention_max_days: 120 });
  });
});

describe("the ceiling setting", () => {
  it("can't be unbounded, and each change is recorded", async () => {
    await expect(setSetting("body_retention_max_days", 731, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(setSetting("body_retention_max_days", 6, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });

    await setSetting("body_retention_max_days", 200, ADMIN);
    const rows = await db.select().from(activity).where(eq(activity.appliesTo, "body_retention_max_days"));
    expect(rows.map((row) => [row.action, row.metadata])).toEqual([
      ["system.setting.changed", { setting: "body_retention_max_days", from: 365, to: 200 }],
    ]);
  });
});
