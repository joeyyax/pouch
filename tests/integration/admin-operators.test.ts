/**
 * The operator surface's people half (#392): accounts under `/v1/admin/users` and memberships
 * under `/v1/admin/organizations/:id/members`. The load-bearing claims are the two refusals —
 * the last admin and the last owner — and the one thing a removal deliberately doesn't do.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, apiKeys, memberships, users } from "@/lib/db/schema";
import { createApiKey } from "@/lib/api/key-lifecycle";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { ROLES, type OrgRole } from "@/lib/auth/permissions";
import { GET as usersGET } from "@/app/api/v1/admin/users/route";
import { DELETE as userDELETE, GET as userGET, PATCH as userPATCH } from "@/app/api/v1/admin/users/[id]/route";
import { POST as organizationsPOST } from "@/app/api/v1/admin/organizations/route";
import { GET as membersGET } from "@/app/api/v1/admin/organizations/[id]/members/route";
import {
  DELETE as memberDELETE,
  PATCH as memberPATCH,
} from "@/app/api/v1/admin/organizations/[id]/members/[userId]/route";
import { seedAdmin, type AdminFixture } from "./admin-fixtures";
import { resetDatabase, seedFixture, seedUser, type Fixture } from "./fixtures";

let admin: AdminFixture;
let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
  admin = await seedAdmin();
});

function get(secret: string, path: string): Request {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${secret}` } });
}

function send(secret: string, path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const one = (id: string) => ({ params: Promise.resolve({ id }) });
const member = (id: string, userId: string) => ({ params: Promise.resolve({ id, userId }) });

// Response bodies are asserted on loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body(response: Response): Promise<any> {
  return response.json();
}

async function memberOf(organizationId: string, role: OrgRole): Promise<{ userId: string; email: string }> {
  const seeded = await seedUser({ organizationId, role });
  return { userId: seeded.userId, email: seeded.email };
}

async function roleOf(organizationId: string, userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId)));
  return row?.role;
}

describe("accounts", () => {
  it("lists accounts with their memberships and narrows to admins", async () => {
    const page = await body(await usersGET(get(admin.secret, "/v1/admin/users?limit=100")));
    const found = page.data.find((row: { id: string }) => row.id === admin.adminUserId);
    expect(found.admin).toBe(true);
    expect(found.email).toContain("@");

    const admins = await body(await usersGET(get(admin.secret, "/v1/admin/users?admin=true")));
    expect(admins.data.every((row: { admin: boolean }) => row.admin)).toBe(true);
  });

  it("finds an account by email and reads its memberships", async () => {
    const seeded = await memberOf(fixture.organizationId, ROLES.MEMBER);

    const page = await body(await usersGET(get(admin.secret, `/v1/admin/users?email=${encodeURIComponent(seeded.email)}`)));
    expect(page.data).toHaveLength(1);

    const account = await body(await userGET(get(admin.secret, "/v1/admin/users/x"), one(seeded.userId)));
    expect(account.memberships).toEqual([
      expect.objectContaining({ organization_id: fixture.organizationId, role: ROLES.MEMBER }),
    ]);
  });

  it("grants and revokes the admin flag, and records each", async () => {
    const seeded = await memberOf(fixture.organizationId, ROLES.MEMBER);

    const granted = await body(
      await userPATCH(send(admin.secret, "/v1/admin/users/x", "PATCH", { admin: true }), one(seeded.userId)),
    );
    expect(granted.admin).toBe(true);

    const revoked = await body(
      await userPATCH(send(admin.secret, "/v1/admin/users/x", "PATCH", { admin: false }), one(seeded.userId)),
    );
    expect(revoked.admin).toBe(false);

    const rows = await db.select({ action: activity.action }).from(activity).where(eq(activity.appliesTo, seeded.userId));
    expect(rows.map((row) => row.action)).toEqual(expect.arrayContaining(["admin.granted", "admin.revoked"]));
  });

  it("refuses to demote or delete the last admin", async () => {
    const demote = await userPATCH(
      send(admin.secret, "/v1/admin/users/x", "PATCH", { admin: false }),
      one(admin.adminUserId),
    );
    expect(demote.status).toBe(422);

    const removed = await userDELETE(send(admin.secret, "/v1/admin/users/x", "DELETE"), one(admin.adminUserId));
    expect(removed.status).toBe(422);
    expect((await body(removed)).error.code).toBe("validation_failed");
  });

  it("deletes an account and its memberships, leaving the organization's keys alone", async () => {
    const seeded = await memberOf(fixture.organizationId, ROLES.MEMBER);
    const { key } = await createApiKey({
      organizationId: fixture.organizationId,
      name: "theirs",
      mode: "live",
      domainIds: [],
      createdBy: seeded.userId,
    });

    const response = await userDELETE(send(admin.secret, "/v1/admin/users/x", "DELETE"), one(seeded.userId));
    expect(response.status).toBe(200);
    expect((await body(response)).deleted).toBe(true);

    expect(await db.select().from(users).where(eq(users.id, seeded.userId))).toHaveLength(0);
    expect(await roleOf(fixture.organizationId, seeded.userId)).toBeUndefined();
    const [row] = await db.select({ revokedAt: apiKeys.revokedAt }).from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(row?.revokedAt).toBeNull();
  });

  it("answers not_found for an unknown account", async () => {
    const response = await userGET(get(admin.secret, "/v1/admin/users/x"), one("usr_nobody"));
    expect(response.status).toBe(404);
  });
});

describe("members", () => {
  it("lists an organization's members oldest first", async () => {
    const seeded = await memberOf(fixture.organizationId, ROLES.MEMBER);

    const page = await body(await membersGET(get(admin.secret, "/v1/admin/x/members"), one(fixture.organizationId)));
    expect(page.data.map((row: { user_id: string }) => row.user_id)).toContain(seeded.userId);
  });

  it("changes a role and records it", async () => {
    const seeded = await memberOf(fixture.organizationId, ROLES.MEMBER);

    const updated = await body(
      await memberPATCH(
        send(admin.secret, "/v1/admin/x/members/y", "PATCH", { role: ROLES.OWNER }),
        member(fixture.organizationId, seeded.userId),
      ),
    );
    expect(updated.role).toBe(ROLES.OWNER);
    expect(await roleOf(fixture.organizationId, seeded.userId)).toBe(ROLES.OWNER);

    const rows = await db.select({ action: activity.action }).from(activity).where(eq(activity.appliesTo, seeded.userId));
    expect(rows.map((row) => row.action)).toContain("member.role.changed");
  });

  it("refuses to delete an account that's the last owner of an organization", async () => {
    const owner = await memberOf(fixture.organizationId, ROLES.OWNER);

    const response = await userDELETE(send(admin.secret, "/v1/admin/users/x", "DELETE"), one(owner.userId));
    expect(response.status).toBe(422);

    expect(await db.select().from(users).where(eq(users.id, owner.userId))).toHaveLength(1);
    const remaining = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(eq(memberships.organizationId, fixture.organizationId));
    expect(remaining.some((row) => row.role === ROLES.OWNER)).toBe(true);
  });

  it("refuses to demote or remove the last owner", async () => {
    const owner = await memberOf(fixture.organizationId, ROLES.OWNER);

    const demoted = await memberPATCH(
      send(admin.secret, "/v1/admin/x/members/y", "PATCH", { role: ROLES.MEMBER }),
      member(fixture.organizationId, owner.userId),
    );
    expect(demoted.status).toBe(422);

    const removed = await memberDELETE(
      send(admin.secret, "/v1/admin/x/members/y", "DELETE"),
      member(fixture.organizationId, owner.userId),
    );
    expect(removed.status).toBe(422);
  });

  it("removes a member and leaves the keys they created sending", async () => {
    await memberOf(fixture.organizationId, ROLES.OWNER);
    const leaving = await memberOf(fixture.organizationId, ROLES.MEMBER);
    const { key } = await createApiKey({
      organizationId: fixture.organizationId,
      name: "theirs",
      mode: "live",
      domainIds: [],
      createdBy: leaving.userId,
    });

    const response = await memberDELETE(
      send(admin.secret, "/v1/admin/x/members/y", "DELETE"),
      member(fixture.organizationId, leaving.userId),
    );
    expect(response.status).toBe(200);
    expect((await body(response)).removed).toBe(true);

    expect(await roleOf(fixture.organizationId, leaving.userId)).toBeUndefined();
    expect(await db.select().from(users).where(eq(users.id, leaving.userId))).toHaveLength(1);
    const [row] = await db.select({ revokedAt: apiKeys.revokedAt }).from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(row?.revokedAt).toBeNull();
  });

  it("answers not_found for an unknown organization or a stranger", async () => {
    const unknownOrganization = await membersGET(get(admin.secret, "/v1/admin/x/members"), one("org_nobody"));
    expect(unknownOrganization.status).toBe(404);

    const stranger = await memberDELETE(
      send(admin.secret, "/v1/admin/x/members/y", "DELETE"),
      member(fixture.organizationId, "usr_nobody"),
    );
    expect(stranger.status).toBe(404);
  });
});

describe("creating an organization", () => {
  it("creates one owned by the key's creator", async () => {
    const response = await organizationsPOST(send(admin.secret, "/v1/admin/organizations", "POST", { name: "Northwind" }));
    expect(response.status).toBe(201);
    const created = await body(response);
    expect(created.slug).toBe("northwind");

    const page = await body(await membersGET(get(admin.secret, "/v1/admin/x/members"), one(created.id)));
    expect(page.data).toEqual([
      expect.objectContaining({ user_id: admin.adminUserId, role: ROLES.OWNER }),
    ]);
  });

  it("refuses a slug that's taken", async () => {
    await organizationsPOST(send(admin.secret, "/v1/admin/organizations", "POST", { name: "Northwind" }));

    const again = await organizationsPOST(send(admin.secret, "/v1/admin/organizations", "POST", { name: "Northwind" }));
    expect(again.status).toBe(422);
    expect((await body(again)).error.field).toBe("slug");
  });
});
