/**
 * Sets a password on an existing account, for when the only way into the dashboard has been
 * lost and the reset email can't reach it (no system organization, or mail isn't arriving).
 *
 * It hashes
 * through Better Auth rather than writing a hash directly, so the stored format is whatever the
 * installed version expects rather than whatever was true when this was written.
 *
 *   RESET_ADMIN_EMAIL=you@example.com RESET_ADMIN_PASSWORD='...' pnpm reset:admin
 *
 * It refuses to create an account: the address must already exist. Every session that account
 * holds is revoked, so a stolen session can't outlive the password it was issued against.
 * Password sign-in is turned back on if an admin turned it off.
 */
import "@/lib/env";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/lib/db";
import { accounts, sessions, users } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { workerActor } from "@/lib/activity/record";
import { enabledSignInMethods } from "@/lib/auth/sign-in-methods";
import { setSetting } from "@/lib/settings/values";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} isn't set.`);
  return value;
}

async function main(): Promise<void> {
  const email = required("RESET_ADMIN_EMAIL");
  const password = required("RESET_ADMIN_PASSWORD");
  if (password.length < 12) throw new Error("RESET_ADMIN_PASSWORD must be at least 12 characters.");

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) throw new Error(`No account for ${email}. This resets an existing one; it never creates one.`);

  const ctx = await auth.$context;
  const passwordHash = await ctx.password.hash(password);

  const [credential] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential")))
    .limit(1);

  if (credential) {
    await db.update(accounts).set({ password: passwordHash }).where(eq(accounts.id, credential.id));
    console.log(`password reset for ${email}`);
  } else {
    // An account created by passkey alone has no credential row to update.
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: passwordHash,
    });
    console.log(`password set for ${email} (no credential login existed)`);
  }

  const revoked = await db.delete(sessions).where(eq(sessions.userId, user.id)).returning({ id: sessions.id });
  console.log(`${revoked.length} session(s) revoked`);

  if (!(await enabledSignInMethods()).password) {
    try {
      await setSetting("sign_in_password", true, workerActor("pnpm reset:admin"));
      console.log("password sign-in turned back on");
    } catch (error) {
      console.log(`password sign-in is still off: ${(error as Error).message}`);
    }
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
