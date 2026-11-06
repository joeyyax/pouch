import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { adminActor, recordActivity, userActor } from "@/lib/activity/record";
import { setSetting } from "@/lib/settings/values";
import { deleteExpiredActivity } from "@/lib/activity/retention";
import { resetDatabase, seedFixture } from "./fixtures";

beforeEach(resetDatabase);
afterEach(() => {
  vi.unstubAllEnvs();
});

const ADMIN = adminActor("usr_admin", "Admin");

const DAY_MS = 86_400_000;

async function seedRow(organizationId: string, action: string, ageDays: number): Promise<string> {
  const id = newId("activity");
  await db.insert(activity).values({
    id,
    organizationId,
    action,
    family: "system",
    outcome: "neutral",
    actorType: "worker",
    actorLabel: "test",
    createdAt: new Date(Date.now() - ageDays * DAY_MS),
  });
  return id;
}

async function survivors(organizationId: string): Promise<string[]> {
  const rows = await db.select({ id: activity.id }).from(activity).where(eq(activity.organizationId, organizationId));
  return rows.map((row) => row.id);
}

describe("deleteExpiredActivity", () => {
  it("deletes a row past its action's retention and keeps one inside it", async () => {
    const { organizationId } = await seedFixture();
    const expired = await seedRow(organizationId, "session.signed_in", 91);
    const fresh = await seedRow(organizationId, "session.signed_in", 89);

    expect(await deleteExpiredActivity()).toBe(1);
    const left = await survivors(organizationId);
    expect(left).toContain(fresh);
    expect(left).not.toContain(expired);
  });

  it("applies each action's own period, not the shortest", async () => {
    const { organizationId } = await seedFixture();
    await seedRow(organizationId, "session.signed_in", 100);
    const longKept = await seedRow(organizationId, "key.created", 100);
    await seedRow(organizationId, "key.created", 800);

    await deleteExpiredActivity();
    expect(await survivors(organizationId)).toEqual([longKept]);
  });

  it("never deletes an action that declares no retention or one the taxonomy doesn't know", async () => {
    const { organizationId } = await seedFixture();
    const kept = await seedRow(organizationId, "organization.deleted", 5000);
    const unknown = await seedRow(organizationId, "legacy.thing.happened", 5000);

    expect(await deleteExpiredActivity()).toBe(0);
    expect((await survivors(organizationId)).sort()).toEqual([kept, unknown].sort());
  });

  it("clears a backlog larger than one batch", async () => {
    const { organizationId } = await seedFixture();
    await db.insert(activity).values(
      Array.from({ length: 25 }, () => ({
        id: newId("activity"),
        organizationId,
        action: "session.signed_out",
        family: "session" as const,
        outcome: "success" as const,
        actorType: "user" as const,
        actorLabel: "test",
        createdAt: new Date(Date.now() - 200 * DAY_MS),
      })),
    );

    expect(await deleteExpiredActivity(10)).toBe(25);
    expect(await survivors(organizationId)).toHaveLength(0);
  });

  it("stops between batches when asked", async () => {
    const { organizationId } = await seedFixture();
    await seedRow(organizationId, "session.signed_in", 200);

    expect(await deleteExpiredActivity(10, () => true)).toBe(0);
    expect(await survivors(organizationId)).toHaveLength(1);
  });
});

describe("the operator's windows", () => {
  it("deletes routine events at the routine window, holding sign-ins to their floor", async () => {
    const { organizationId } = await seedFixture();
    const listChurn = await seedRow(organizationId, "list.member.added", 40);
    const signIn = await seedRow(organizationId, "session.signed_in", 40);
    await seedRow(organizationId, "session.signed_in", 91);

    expect(await deleteExpiredActivity()).toBe(1);
    expect((await survivors(organizationId)).sort()).toEqual([listChurn, signIn].sort());

    await setSetting("activity_churn_retention_days", 30, ADMIN);
    expect(await deleteExpiredActivity()).toBe(1);
    expect(await survivors(organizationId)).toEqual([signIn]);
  });

  it("keeps sign-ins longer when the routine window is raised past the floor", async () => {
    const { organizationId } = await seedFixture();
    const signIn = await seedRow(organizationId, "session.signed_in", 120);

    vi.stubEnv("ACTIVITY_CHURN_RETENTION_DAYS", "180");
    expect(await deleteExpiredActivity()).toBe(0);
    expect(await survivors(organizationId)).toEqual([signIn]);
  });

  it("deletes setup changes at the setup window", async () => {
    const { organizationId } = await seedFixture();
    const key = await seedRow(organizationId, "key.revoked", 400);

    expect(await deleteExpiredActivity()).toBe(0);
    await setSetting("activity_retention_days", 365, ADMIN);
    expect(await deleteExpiredActivity()).toBe(1);
    expect(await survivors(organizationId)).not.toContain(key);
  });

  it("refuses a setup window under a year", async () => {
    await expect(setSetting("activity_retention_days", 364, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(setSetting("activity_churn_retention_days", 6, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("recordActivity client", () => {
  const client = { ipHash: "hashed-address", userAgent: "TestAgent/1.0" };

  it("keeps the address hash and user agent for an action that allows them", async () => {
    const { organizationId } = await seedFixture();
    await recordActivity({ organizationId, action: "session.sign_in.failed", actor: userActor("u1", "Ada"), client });

    const [row] = await db.select().from(activity).where(eq(activity.organizationId, organizationId));
    expect(row?.ipHash).toBe("hashed-address");
    expect(row?.userAgent).toBe("TestAgent/1.0");
  });

  it("drops both for an action that doesn't", async () => {
    const { organizationId } = await seedFixture();
    await recordActivity({ organizationId, action: "key.created", actor: userActor("u1", "Ada"), client });

    const [row] = await db.select().from(activity).where(eq(activity.organizationId, organizationId));
    expect(row?.ipHash).toBeNull();
    expect(row?.userAgent).toBeNull();
  });

  it("truncates a long user agent", async () => {
    const { organizationId } = await seedFixture();
    await recordActivity({
      organizationId,
      action: "session.signed_in",
      actor: userActor("u1", "Ada"),
      client: { ipHash: null, userAgent: "a".repeat(1000) },
    });

    const [row] = await db.select().from(activity).where(eq(activity.organizationId, organizationId));
    expect(row?.userAgent).toHaveLength(255);
  });
});
