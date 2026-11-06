import { beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { deleteUserAccount, isAdmin, LastAdminError, setAdmin } from "@/lib/auth/admin";
import { resetDatabase, seedUser } from "./fixtures";

async function makeUser(admin: boolean): Promise<string> {
  return (await seedUser({ admin })).userId;
}

beforeEach(resetDatabase);

describe("isAdmin", () => {
  it.each([
    ["true for a user with the admin flag set", () => makeUser(true), true],
    ["false for a user without the admin flag", () => makeUser(false), false],
    ["false for an unknown user id", async () => "nope", false],
  ])("is %s", async (_name, seed, expected) => {
    expect(await isAdmin(await seed())).toBe(expected);
  });
});

describe("setAdmin", () => {
  it("refuses to demote the only remaining admin", async () => {
    const userId = await makeUser(true);

    await expect(setAdmin(userId, false)).rejects.toThrow(LastAdminError);
    await expect(setAdmin(userId, false)).rejects.toThrow("This is the only admin. Promote someone else first.");

    expect(await isAdmin(userId)).toBe(true);
  });

  it("allows demoting an admin when another one remains, and promoting a non-admin regardless", async () => {
    const admin = await makeUser(true);
    await makeUser(true);
    const member = await makeUser(false);

    await setAdmin(admin, false);
    await setAdmin(member, true);

    expect(await isAdmin(admin)).toBe(false);
    expect(await isAdmin(member)).toBe(true);
  });
});

describe("deleteUserAccount", () => {
  it("refuses to delete the only remaining admin", async () => {
    const userId = await makeUser(true);

    await expect(deleteUserAccount(userId)).rejects.toThrow(LastAdminError);

    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(row).toBeDefined();
  });

  it("allows deleting an admin when another one remains, and a non-admin with no guard at all", async () => {
    const admin = await makeUser(true);
    await makeUser(true);
    const member = await makeUser(false);

    await deleteUserAccount(admin);
    await deleteUserAccount(member);

    expect(await db.select().from(users).where(inArray(users.id, [admin, member]))).toEqual([]);
  });
});
