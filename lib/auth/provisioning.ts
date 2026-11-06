import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { auth } from "@/lib/auth";
import type { OrgRole } from "./permissions";

/**
 * Creates the membership that gives a just-created user access to one organization.
 *
 * Also carries the bootstrap rule: if this user turns out to be the very first user in the
 * system, they're promoted to admin right here, in the same transaction as the membership
 * insert. This is evaluated once, at creation — never re-checked on login or by counting users
 * later, which would silently hand out admin access to whoever happens to remain after
 * other accounts are deleted.
 *
 * Pouch's own admin comes from the seed script, which sets `admin` explicitly and doesn't
 * call this — see scripts/seed.ts. This path exists for whatever creates a user afterward,
 * starting with invitation redemption (`lib/invitations.ts`).
 */
export async function createMembershipForNewUser(userId: string, organizationId: string, role: OrgRole): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ count: sql<number>`count(*)` }).from(users);
    if (Number(row?.count ?? 0) === 1) {
      await tx.update(users).set({ admin: true }).where(eq(users.id, userId));
    }

    await tx.insert(memberships).values({ id: newId("membership"), userId, organizationId, role }).onConflictDoNothing();
  });
}

interface NewAccount {
  email: string;
  name: string;
  organizationId: string;
  emailVerified: boolean;
  admin?: boolean;
}

/** Creates a user with no credential, for an invitation accepted while password sign-in is off. */
export async function createAccountWithoutPassword(input: NewAccount): Promise<{ id: string }> {
  const ctx = await auth.$context;
  return ctx.internalAdapter.createUser(
    {
      email: input.email,
      name: input.name,
      organizationId: input.organizationId,
      emailVerified: input.emailVerified,
      ...(input.admin === undefined ? {} : { admin: input.admin }),
    },
    { method: "admin" },
  );
}

/**
 * Creates a user and its credential account through Better Auth's internal adapter. The one
 * path that hashes a password for a new account — the seed script, dev data and invitation
 * redemption all come through here.
 */
export async function createAccountWithPassword(input: NewAccount & { password: string }): Promise<{ id: string }> {
  const ctx = await auth.$context;
  const passwordHash = await ctx.password.hash(input.password);
  const created = await ctx.internalAdapter.createUser(
    {
      email: input.email,
      name: input.name,
      organizationId: input.organizationId,
      emailVerified: input.emailVerified,
      ...(input.admin === undefined ? {} : { admin: input.admin }),
    },
    { method: "admin" },
  );
  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: "credential",
    accountId: created.id,
    password: passwordHash,
  });
  return created;
}
