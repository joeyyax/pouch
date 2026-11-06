import { eq } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { revokeAdminKeysCreatedBy, sendRevokedAlerts } from "@/lib/api/key-lifecycle";
import { users } from "@/lib/db/schema";
import { assertOwnerRemovable } from "@/lib/memberships";
import { getSession } from "./session";

/** Non-throwing check on the service-wide admin flag, for deciding whether to show admin-only affordances. */
export async function isAdmin(userId: string): Promise<boolean> {
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { admin: true },
  });
  return Boolean(row?.admin);
}

/**
 * Require the current user to be a service admin. Throws `Error("Unauthorized")` when nobody
 * is signed in, `Error("Forbidden")` when they are but aren't an admin.
 */
export async function requireAdmin() {
  const session = await getSession();
  if (!session?.user?.id) throw new Error("Unauthorized");
  if (!(await isAdmin(session.user.id))) throw new Error("Forbidden");
  return session;
}

export class LastAdminError extends Error {
  constructor() {
    super("This is the only admin. Promote someone else first.");
    this.name = "LastAdminError";
  }
}

/**
 * Throws `LastAdminError` if `userId` is the only admin left. A system with no admin has no
 * way back in short of editing the database by hand, so demoting or deleting the last one is
 * refused rather than allowed and regretted. Locks the admin rows, so two concurrent
 * demotions can't both pass.
 */
export async function assertAdminRemovable(userId: string, executor: Executor = db): Promise<void> {
  const rows = await executor.select({ id: users.id }).from(users).where(eq(users.admin, true)).for("update");
  if (!rows.some((row) => row.id !== userId)) {
    throw new LastAdminError();
  }
}

/**
 * Sets the service-wide admin flag. Demoting the last admin is refused (see
 * `assertAdminRemovable`), and demoting revokes the admin keys the user created.
 */
export async function setAdmin(userId: string, admin: boolean): Promise<void> {
  const revoked = await db.transaction(async (tx) => {
    if (admin) {
      await tx.update(users).set({ admin }).where(eq(users.id, userId));
      return [];
    }
    await assertAdminRemovable(userId, tx);
    await tx.update(users).set({ admin }).where(eq(users.id, userId));
    return revokeAdminKeysCreatedBy(userId, "creator_demoted", tx);
  });
  await sendRevokedAlerts(revoked);
}

/**
 * Deletes a user account and revokes the admin keys it created. Deleting the last admin is
 * refused (see `assertAdminRemovable`), and so is deleting the last owner of an organization
 * (see `assertOwnerRemovable`) — memberships cascade, so the organization would be left with
 * nobody able to manage it.
 */
export async function deleteUserAccount(userId: string): Promise<void> {
  const revoked = await db.transaction(async (tx) => {
    const [row] = await tx.select({ admin: users.admin }).from(users).where(eq(users.id, userId)).for("update");
    if (row?.admin) await assertAdminRemovable(userId, tx);
    await assertOwnerRemovable(userId, tx);
    const keys = await revokeAdminKeysCreatedBy(userId, "creator_deleted", tx);
    await tx.delete(users).where(eq(users.id, userId));
    return keys;
  });
  await sendRevokedAlerts(revoked);
}
