import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, domains, suppressions } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { adminActor, recordActivity, userActor, workerActor } from "@/lib/activity/record";
import { listActivity, listServiceActivity } from "@/lib/activity/query";
import { suppress } from "@/lib/messages/suppression";
import { resetDatabase, seedFixture } from "./fixtures";

beforeEach(async () => {
  await resetDatabase();
});

describe("recordActivity", () => {
  it("writes a row classified with the action's family and outcome", async () => {
    const fixture = await seedFixture();
    await recordActivity({
      organizationId: fixture.organizationId,
      action: "key.created",
      actor: userActor("u1", "Ada"),
      appliesTo: fixture.key.id,
      subjectLabel: fixture.key.name,
    });

    const [row] = await db.select().from(activity).where(eq(activity.organizationId, fixture.organizationId));
    expect(row?.action).toBe("key.created");
    expect(row?.family).toBe("key");
    expect(row?.outcome).toBe("success");
    expect(row?.actorType).toBe("user");
    expect(row?.actorLabel).toBe("Ada");
  });

  // WRITES ARE NON-FATAL: a broken insert must never surface to the caller. Proven here with a
  // real constraint violation (an organization id nothing references), not a mock — the same
  // failure mode a flapping Postgres connection produces.
  it("does not throw when the insert violates a constraint, and persists nothing", async () => {
    await expect(
      recordActivity({
        organizationId: "org_does_not_exist",
        action: "key.created",
        actor: workerActor(),
      }),
    ).resolves.toBeUndefined();

    const rows = await db.select().from(activity).where(eq(activity.organizationId, "org_does_not_exist"));
    expect(rows).toHaveLength(0);
  });
});

describe("listActivity cursor pagination", () => {
  it("doesn't drop or duplicate rows that share a millisecond, across page boundaries", async () => {
    const fixture = await seedFixture();
    const sharedInstant = new Date("2026-01-01T00:00:00.000Z");
    const ids = ["act_c", "act_b", "act_a"].map(() => newId("activity"));

    for (const id of ids) {
      await db.insert(activity).values({
        id,
        organizationId: fixture.organizationId,
        action: "key.created",
        family: "key",
        outcome: "success",
        actorType: "worker",
        actorId: null,
        actorLabel: "Pouch",
        createdAt: sharedInstant,
      });
    }

    // One row per page forces every boundary in this three-row, one-instant set to fall
    // exactly on the tie the (created_at, id) cursor exists to break.
    const seen: string[] = [];
    let cursor = null as Awaited<ReturnType<typeof listActivity>>["nextCursor"];
    for (let i = 0; i < 10; i += 1) {
      const page = await listActivity(fixture.organizationId, { families: [], outcomes: [], actors: [], since: null }, cursor, 1);
      seen.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(seen.sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(ids.length);
  });
});

describe("subject resolution", () => {
  it("links to the subject while it exists and falls back to the write-time label once it's gone", async () => {
    const fixture = await seedFixture();
    await recordActivity({
      organizationId: fixture.organizationId,
      action: "domain.added",
      actor: userActor("u1", "Ada"),
      appliesTo: fixture.domainId,
      subjectLabel: "example.com",
    });

    const before = await listActivity(fixture.organizationId, { families: [], outcomes: [], actors: [], since: null });
    expect(before.rows[0]?.subjectHref).toBe(`/domains/${fixture.domainId}`);
    expect(before.rows[0]?.subjectLabel).toBe("example.com");

    await db.delete(domains).where(eq(domains.id, fixture.domainId));

    const after = await listActivity(fixture.organizationId, { families: [], outcomes: [], actors: [], since: null });
    expect(after.rows[0]?.subjectHref).toBeNull();
    expect(after.rows[0]?.subjectLabel).toBe("example.com");
  });

  it("never persists a suppressed address — it's read live and disappears with the suppression row", async () => {
    const fixture = await seedFixture();
    const added = await suppress({ organizationId: fixture.organizationId, address: "gone@example.com", reason: "manual" });
    expect(added).toBe(true);
    const [row] = await db
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(and(eq(suppressions.organizationId, fixture.organizationId), eq(suppressions.address, "gone@example.com")));
    if (!row) throw new Error("suppression row missing");

    await recordActivity({
      organizationId: fixture.organizationId,
      action: "suppression.added",
      actor: userActor("u1", "Ada"),
      appliesTo: row.id,
    });

    const [storedRow] = await db.select().from(activity).where(eq(activity.organizationId, fixture.organizationId));
    // The address itself is never written to the activity table — only the suppression's id.
    expect(JSON.stringify(storedRow)).not.toContain("gone@example.com");

    const live = await listActivity(fixture.organizationId, { families: [], outcomes: [], actors: [], since: null });
    expect(live.rows[0]?.subjectLabel).toBe("gone@example.com");

    await db.delete(suppressions).where(eq(suppressions.id, row.id));

    const afterRemoval = await listActivity(fixture.organizationId, { families: [], outcomes: [], actors: [], since: null });
    expect(afterRemoval.rows[0]?.subjectLabel).toBeNull();
    expect(afterRemoval.rows[0]?.subjectHref).toBeNull();
  });
});

describe("filters", () => {
  it("narrows by family, outcome and actor", async () => {
    const fixture = await seedFixture();
    await recordActivity({ organizationId: fixture.organizationId, action: "key.created", actor: userActor("u1", "Ada") });
    await recordActivity({ organizationId: fixture.organizationId, action: "session.sign_in.failed", actor: userActor("u2", "Bea") });

    const byFamily = await listActivity(fixture.organizationId, { families: ["session"], outcomes: [], actors: [], since: null });
    expect(byFamily.rows).toHaveLength(1);
    expect(byFamily.rows[0]?.action).toBe("session.sign_in.failed");

    const byOutcome = await listActivity(fixture.organizationId, { families: [], outcomes: ["failure"], actors: [], since: null });
    expect(byOutcome.rows).toHaveLength(1);

    const byActor = await listActivity(fixture.organizationId, { families: [], outcomes: [], actors: ["user:u1"], since: null });
    expect(byActor.rows).toHaveLength(1);
    expect(byActor.rows[0]?.actor.label).toBe("Ada");
  });
});

describe("listServiceActivity", () => {
  it("returns only rows that belong to no organization, newest first", async () => {
    const fixture = await seedFixture();
    await recordActivity({
      organizationId: fixture.organizationId,
      action: "key.created",
      actor: userActor("u1", "Ada"),
      subjectLabel: "an organization key",
    });
    await recordActivity({
      organizationId: null,
      action: "provider.created",
      actor: adminActor("a1", "Admin"),
      subjectLabel: "Northgate",
    });
    await recordActivity({
      organizationId: null,
      action: "provider.settings.changed",
      actor: adminActor("a1", "Admin"),
      subjectLabel: "Northgate",
    });

    const { rows } = await listServiceActivity();
    expect(rows.map((row) => row.action)).toEqual(["provider.settings.changed", "provider.created"]);
    expect(rows.every((row) => row.subjectHref === null)).toBe(true);
  });

  it("honors the limit", async () => {
    for (const label of ["a", "b", "c"]) {
      await recordActivity({
        organizationId: null,
        action: "provider.created",
        actor: adminActor("a1", "Admin"),
        subjectLabel: label,
      });
    }
    const { rows, nextCursor } = await listServiceActivity(null, 2);
    expect(rows).toHaveLength(2);
    expect(nextCursor).not.toBeNull();
  });

  // Same tie the organization feed's cursor exists to break, on the scope that has no
  // organization to narrow it: every row here shares one instant and one actor.
  it("pages through every row without dropping or duplicating one that shares a millisecond", async () => {
    const fixture = await seedFixture();
    const sharedInstant = new Date("2026-02-01T00:00:00.000Z");
    const ids = ["a", "b", "c"].map(() => newId("activity"));

    for (const id of ids) {
      await db.insert(activity).values({
        id,
        organizationId: null,
        action: "provider.created",
        family: "provider",
        outcome: "success",
        actorType: "admin",
        actorId: "a1",
        actorLabel: "Admin",
        createdAt: sharedInstant,
      });
    }
    // An organization row at the same instant must never appear on a service page.
    await db.insert(activity).values({
      id: newId("activity"),
      organizationId: fixture.organizationId,
      action: "key.created",
      family: "key",
      outcome: "success",
      actorType: "user",
      actorId: "u1",
      actorLabel: "Ada",
      createdAt: sharedInstant,
    });

    const seen: string[] = [];
    let cursor = null as Awaited<ReturnType<typeof listServiceActivity>>["nextCursor"];
    for (let i = 0; i < 10; i += 1) {
      const page = await listServiceActivity(cursor, 1);
      seen.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(seen.sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(ids.length);
  });
});
