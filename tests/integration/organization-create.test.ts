/**
 * #164 follow-up: creating an organization from the dashboard. `createOrganization` is the one
 * path a signed-in user's "Add organization" goes through — the load-bearing guarantee is that
 * the organization row and the creator's owner membership land together or not at all, so
 * nothing ever exists that its creator can't reach. `createOrganizationAction` is the server
 * action wrapping it: refuses an unauthenticated caller, sets the active-organization cookie so
 * the creator lands in the new organization, and turns a slug collision into a field-scoped
 * error rather than a 500.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, memberships, organizations, users } from "@/lib/db/schema";
import { adminActor } from "@/lib/activity/record";
import { setSetting } from "@/lib/settings/values";
import { ROLES } from "@/lib/auth/permissions";
import { createOrganization, SlugTakenError } from "@/lib/organizations";
import { form, resetDatabase, seedFixture, type Fixture } from "./fixtures";

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

async function userOf(organizationId: string): Promise<string> {
  const userId = crypto.randomUUID();
  await db.insert(users).values({ id: userId, organizationId, name: "Creator", email: `${userId}@example.com` });
  return userId;
}

describe("createOrganization", () => {
  it("creates the organization and the creator's owner membership together", async () => {
    const creatorId = await userOf(fixture.organizationId);

    const org = await createOrganization({ name: "Acme", slug: "acme" }, creatorId);

    const [row] = await db.select().from(organizations).where(eq(organizations.id, org.id)).limit(1);
    expect(row?.name).toBe("Acme");
    expect(row?.slug).toBe("acme");

    const [membership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.organizationId, org.id))
      .limit(1);
    expect(membership?.userId).toBe(creatorId);
    expect(membership?.role).toBe(ROLES.OWNER);
  });

  it("derives a slug from the name when none is given", async () => {
    const creatorId = await userOf(fixture.organizationId);

    const org = await createOrganization({ name: "Acme Corp" }, creatorId);

    expect(org.slug).toBe("acme-corp");
  });

  it("THE LOAD-BEARING CASE: no orphan organization when the membership write fails", async () => {
    const before = await db.select().from(organizations);

    await expect(createOrganization({ name: "Orphan Co", slug: "orphan-co" }, "nonexistent-user-id")).rejects.toThrow();

    const after = await db.select().from(organizations);
    expect(after).toHaveLength(before.length);
    const found = after.find((row) => row.slug === "orphan-co");
    expect(found).toBeUndefined();
  });

  it("refuses a slug that's already taken", async () => {
    const creatorId = await userOf(fixture.organizationId);
    await createOrganization({ name: "First", slug: "taken" }, creatorId);

    await expect(createOrganization({ name: "Second", slug: "taken" }, creatorId)).rejects.toThrow(SlugTakenError);
  });
});

const sessionState = vi.hoisted(() => ({ userId: null as string | null }));
const cookieState = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("@/lib/auth/session", async () => (await import("./fixtures")).adminSessionModule(sessionState));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieState.store.has(name) ? { value: cookieState.store.get(name) } : undefined),
    set: (name: string, value: string) => {
      cookieState.store.set(name, value);
    },
    delete: (name: string) => {
      cookieState.store.delete(name);
    },
  }),
}));

const { createOrganizationAction } = await import("../../app/(app)/create-organization-action");
const { ACTIVE_ORGANIZATION_COOKIE } = await import("@/lib/dashboard/session");

describe("createOrganizationAction", () => {
  beforeEach(() => {
    sessionState.userId = null;
    cookieState.store.clear();
  });

  it("refuses an unauthenticated caller, server-side, without creating anything", async () => {
    const before = await db.select().from(organizations);

    const state = await createOrganizationAction({ status: "idle" }, form({ name: "Nope", slug: "nope" }));

    expect(state.status).toBe("error");
    const after = await db.select().from(organizations);
    expect(after).toHaveLength(before.length);
    expect(cookieState.store.get(ACTIVE_ORGANIZATION_COOKIE)).toBeUndefined();
  });

  it("creates the organization and switches the caller into it", async () => {
    const creatorId = await userOf(fixture.organizationId);
    sessionState.userId = creatorId;

    const state = await createOrganizationAction({ status: "idle" }, form({ name: "New Co", slug: "new-co" }));

    expect(state.status).toBe("ok");
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, "new-co")).limit(1);
    expect(org).toBeDefined();
    expect(cookieState.store.get(ACTIVE_ORGANIZATION_COOKIE)).toBe(org!.id);

    const [membership] = await db.select().from(memberships).where(eq(memberships.organizationId, org!.id)).limit(1);
    expect(membership?.userId).toBe(creatorId);
    expect(membership?.role).toBe(ROLES.OWNER);
  });

  it("a slug collision comes back as a field error, not a thrown error", async () => {
    const creatorId = await userOf(fixture.organizationId);
    sessionState.userId = creatorId;
    await createOrganization({ name: "First", slug: "dup" }, creatorId);

    const state = await createOrganizationAction({ status: "idle" }, form({ name: "Second", slug: "dup" }));

    expect(state.status).toBe("error");
    expect(state.status === "error" && state.field).toBe("slug");
  });
});

describe("who creates organizations", () => {
  const ADMIN = adminActor("usr_admin", "Admin");

  async function createAs(userId: string, slug: string) {
    sessionState.userId = userId;
    return createOrganizationAction({ status: "idle" }, form({ name: slug, slug }));
  }

  /** A member of the fixture's organization; also an owner of one of their own, or an admin. */
  async function person({ owner = false, admin = false } = {}): Promise<string> {
    const userId = await userOf(fixture.organizationId);
    await db.insert(memberships).values({ id: crypto.randomUUID(), userId, organizationId: fixture.organizationId, role: ROLES.MEMBER });
    if (owner) await createOrganization({ name: "Owned", slug: `owned-${userId}` }, userId);
    if (admin) await db.update(users).set({ admin: true }).where(eq(users.id, userId));
    return userId;
  }

  beforeEach(() => {
    sessionState.userId = null;
    cookieState.store.clear();
  });

  it("is anyone signed in by default, which is how it worked before the setting", async () => {
    expect((await createAs(await person(), "open-member")).status).toBe("ok");
  });

  it("records the creation in the activity log", async () => {
    const userId = await person();
    await createAs(userId, "logged");

    const [org] = await db.select().from(organizations).where(eq(organizations.slug, "logged")).limit(1);
    const [row] = await db.select().from(activity).where(and(eq(activity.action, "organization.created"), eq(activity.organizationId, org!.id)));
    expect(row?.actorId).toBe(userId);
  });

  it("under owners, refuses a member who owns nothing and lets an owner or an admin create one", async () => {
    await setSetting("organization_creation", "owners", ADMIN);

    expect((await createAs(await person(), "owners-member")).status).toBe("error");
    expect(await db.select().from(organizations).where(eq(organizations.slug, "owners-member"))).toHaveLength(0);

    expect((await createAs(await person({ owner: true }), "owners-owner")).status).toBe("ok");
    expect((await createAs(await person({ admin: true }), "owners-admin")).status).toBe("ok");
  });

  it("under closed, refuses an owner and lets only an admin create one", async () => {
    await setSetting("organization_creation", "closed", ADMIN);

    expect((await createAs(await person({ owner: true }), "closed-owner")).status).toBe("error");
    expect(await db.select().from(organizations).where(eq(organizations.slug, "closed-owner"))).toHaveLength(0);

    expect(await createAs(await person({ admin: true }), "closed-admin")).toMatchObject({ status: "ok" });
  });

  it("under open, lets a member who owns nothing create one", async () => {
    await setSetting("organization_creation", "closed", ADMIN);
    await setSetting("organization_creation", "open", ADMIN);

    expect((await createAs(await person(), "open-again")).status).toBe("ok");
  });

  it("refuses a mode it doesn't know, the old invite name included", async () => {
    await expect(setSetting("organization_creation", "invite", ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(setSetting("organization_creation", "public", ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
  });
});
