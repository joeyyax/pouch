/**
 * `setMembershipRole` (#376). The last-owner guard is the load-bearing part: an organization
 * with nobody to own it has no way to manage its own people back.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import { ROLES } from "@/lib/auth/permissions";
import { LastOwnerError, setMembershipRole } from "@/lib/memberships";
import { memberOf, resetDatabase, seedFixture, type Fixture } from "./fixtures";

let fixture: Fixture;

async function roleOf(userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, fixture.organizationId)));
  return row?.role;
}

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

describe("setMembershipRole", () => {
  it("promotes a member to owner", async () => {
    const memberId = await memberOf(fixture.organizationId, ROLES.MEMBER);

    await setMembershipRole(fixture.organizationId, memberId, ROLES.OWNER);

    expect(await roleOf(memberId)).toBe(ROLES.OWNER);
  });

  it("refuses to demote the only owner", async () => {
    const ownerId = await memberOf(fixture.organizationId, ROLES.OWNER);

    await expect(setMembershipRole(fixture.organizationId, ownerId, ROLES.MEMBER)).rejects.toThrow(LastOwnerError);
    expect(await roleOf(ownerId)).toBe(ROLES.OWNER);
  });

  it("demotes an owner when another one remains", async () => {
    const first = await memberOf(fixture.organizationId, ROLES.OWNER);
    await memberOf(fixture.organizationId, ROLES.OWNER);

    await setMembershipRole(fixture.organizationId, first, ROLES.MEMBER);

    expect(await roleOf(first)).toBe(ROLES.MEMBER);
  });

  it("is a no-op when the role already matches", async () => {
    const memberId = await memberOf(fixture.organizationId, ROLES.MEMBER);

    await setMembershipRole(fixture.organizationId, memberId, ROLES.MEMBER);

    expect(await roleOf(memberId)).toBe(ROLES.MEMBER);
  });

  it("refuses someone who isn't in the organization", async () => {
    await expect(setMembershipRole(fixture.organizationId, "usr_nobody", ROLES.MEMBER)).rejects.toThrow(
      "That person isn't in this organization.",
    );
  });
});
