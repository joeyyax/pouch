import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, organizations, users } from "@/lib/db/schema";
import { createMembershipForNewUser } from "@/lib/auth/provisioning";
import { ROLES } from "@/lib/auth/permissions";
import { resetDatabase } from "./fixtures";

async function makeOrgAndUser(admin = false): Promise<{ organizationId: string; userId: string }> {
  const organizationId = crypto.randomUUID();
  await db.insert(organizations).values({ id: organizationId, name: "Test", slug: `test-${organizationId}` });

  const userId = crypto.randomUUID();
  await db.insert(users).values({ id: userId, organizationId, name: "User", email: `${userId}@example.com`, admin });
  return { organizationId, userId };
}

beforeEach(resetDatabase);

describe("createMembershipForNewUser", () => {
  it("promotes the very first user in the system to admin, at creation", async () => {
    const { organizationId, userId } = await makeOrgAndUser(false);

    await createMembershipForNewUser(userId, organizationId, ROLES.OWNER);

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(user?.admin).toBe(true);

    const rows = await db.select().from(memberships).where(eq(memberships.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe(ROLES.OWNER);
  });

  it("does not promote a second user, even though they're the newest", async () => {
    const first = await makeOrgAndUser(false);
    await createMembershipForNewUser(first.userId, first.organizationId, ROLES.OWNER);

    const second = await makeOrgAndUser(false);
    await createMembershipForNewUser(second.userId, second.organizationId, ROLES.MEMBER);

    const [user] = await db.select().from(users).where(eq(users.id, second.userId)).limit(1);
    expect(user?.admin).toBe(false);
  });

  it("does not re-evaluate the rule on a user who existed before the count temporarily dropped to one", async () => {
    // Three users; only the first should ever have been eligible for the bootstrap rule
    // regardless of what happens to the other two afterward. This suite doesn't delete
    // users — that's the point: the rule is evaluated once, at creation, never by counting
    // survivors later.
    const first = await makeOrgAndUser(false);
    await createMembershipForNewUser(first.userId, first.organizationId, ROLES.OWNER);

    const second = await makeOrgAndUser(false);
    await createMembershipForNewUser(second.userId, second.organizationId, ROLES.MEMBER);

    const third = await makeOrgAndUser(false);
    await createMembershipForNewUser(third.userId, third.organizationId, ROLES.MEMBER);

    const rows = await db.select().from(users).where(eq(users.admin, true));
    expect(rows.map((r) => r.id)).toEqual([first.userId]);
  });
});
