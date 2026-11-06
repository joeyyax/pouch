import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, organizations, users } from "@/lib/db/schema";
import { ROLES } from "@/lib/auth/permissions";
import { DEV_ACCOUNTS, DEV_ACCOUNT_KEYS, DEV_SECOND_ORGANIZATION } from "@/lib/dev/seed-accounts";
import { newId } from "@/lib/ids";
import { resetDatabase } from "./fixtures";

const run = promisify(execFile);
const PRIMARY_SLUG = "dev-data-test-primary";

async function primaryOrganization(): Promise<string> {
  const id = newId("organization");
  await db.insert(organizations).values({ id, name: "Primary", slug: PRIMARY_SLUG });
  return id;
}

/** Runs the dev-data script against the test database. `clear` stays cheap — no storage writes
 * — since the dev account cast is seeded before the fill/clear/reset branch either way. */
async function devData(command: "clear" | "fill" | "reset" = "clear"): Promise<void> {
  await run("pnpm", ["exec", "tsx", "scripts/dev-data.ts", command], {
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, SEED_ORGANIZATION_SLUG: PRIMARY_SLUG },
  });
}

async function devUsers() {
  return db
    .select()
    .from(users)
    .where(
      inArray(
        users.email,
        DEV_ACCOUNT_KEYS.map((key) => DEV_ACCOUNTS[key].email),
      ),
    );
}

beforeEach(resetDatabase);

describe("scripts/dev-data.ts dev account cast", () => {
  it("throws without a primary organization to seed the cast into", async () => {
    await expect(devData()).rejects.toThrow();
  });

  it("seeds an admin with no membership, an owner and member in the primary org, and member2 in both, once however often it runs", async () => {
    const primaryOrgId = await primaryOrganization();
    await devData();

    const rows = await devUsers();
    expect(rows).toHaveLength(4);

    const admin = rows.find((row) => row.email === DEV_ACCOUNTS.admin.email);
    expect(admin?.admin).toBe(true);

    const [secondOrg] = await db.select().from(organizations).where(eq(organizations.slug, DEV_SECOND_ORGANIZATION.slug)).limit(1);
    expect(secondOrg).toBeDefined();

    const owner = rows.find((row) => row.email === DEV_ACCOUNTS.owner.email)!;
    const ownerMemberships = await db.select().from(memberships).where(eq(memberships.userId, owner.id));
    expect(ownerMemberships).toHaveLength(1);
    expect(ownerMemberships[0]?.organizationId).toBe(primaryOrgId);
    expect(ownerMemberships[0]?.role).toBe(ROLES.OWNER);

    const member = rows.find((row) => row.email === DEV_ACCOUNTS.member.email)!;
    const memberMemberships = await db.select().from(memberships).where(eq(memberships.userId, member.id));
    expect(memberMemberships).toHaveLength(1);
    expect(memberMemberships[0]?.organizationId).toBe(primaryOrgId);
    expect(memberMemberships[0]?.role).toBe(ROLES.MEMBER);

    const member2 = rows.find((row) => row.email === DEV_ACCOUNTS.member2.email)!;
    const member2Memberships = await db.select().from(memberships).where(eq(memberships.userId, member2.id));
    expect(member2Memberships).toHaveLength(2);
    expect(member2Memberships.map((m) => m.organizationId).sort()).toEqual([primaryOrgId, secondOrg!.id].sort());

    await devData();

    expect(await devUsers()).toHaveLength(4);
    expect(await db.select().from(organizations).where(eq(organizations.slug, DEV_SECOND_ORGANIZATION.slug))).toHaveLength(1);
    // owner (1) + member (1) + member2 (2) = 4; admin carries none.
    expect(
      await db.select().from(memberships).where(
        inArray(
          memberships.userId,
          rows.map((row) => row.id),
        ),
      ),
    ).toHaveLength(4);
  });
});
