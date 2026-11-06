import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { recordActivity, userActor, type RecordActivityOptions } from "@/lib/activity/record";

type Client = RecordActivityOptions["client"];

export type SignInMethod = "passkey" | "magic_link";

interface SignedInUser {
  id: string;
  name?: string | null;
  email?: string | null;
  organizationId?: string;
}

/** Records a completed sign-in against the account's own organization. */
export async function recordSignIn(user: SignedInUser, client?: Client, method?: SignInMethod): Promise<void> {
  await record(user, "session.signed_in", client, method ? { method } : undefined);
}

/** Records a sign-out, called while the session being ended is still the caller's own. */
export async function recordSignOut(user: SignedInUser): Promise<void> {
  await record(user, "session.signed_out");
}

/**
 * Records a refused sign-in against the account the email names. An address with no account
 * logs nothing: no organization's operator would be able to see the row.
 */
export async function recordSignInFailed(email: string, client?: Client): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;

  // Matches the lookup Better Auth itself does in `/sign-in/email` (lowercased, exact).
  const [user] = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
  if (!user) return;

  await recordActivity({
    organizationId: user.organizationId,
    action: "session.sign_in.failed",
    actor: userActor(user.id, user.name || user.email),
    client,
  });
}

async function record(
  user: SignedInUser,
  action: "session.signed_in" | "session.signed_out",
  client?: Client,
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (!user.organizationId) return;
  await recordActivity({
    organizationId: user.organizationId,
    action,
    actor: userActor(user.id, user.name || user.email || ""),
    client,
    metadata,
  });
}
