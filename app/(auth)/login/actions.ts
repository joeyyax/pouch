"use server";

/**
 * Sign-in activity, recorded from the server actions the login form and the sign-out button
 * call around Better Auth's own client calls, rather than from a Better Auth hook — the
 * session Better Auth hands the after-hook for `/sign-out` has already been deleted by the
 * time it runs. Both need a session, so neither can be forged. A failed sign-in has no
 * session and is recorded by the `hooks.after` in `lib/auth/index.ts`.
 */
import { headers } from "next/headers";
import { clientOf } from "@/lib/api/client-ip";
import { recordSignIn, recordSignOut } from "@/lib/auth/sign-in-activity";
import { requireSession } from "@/lib/auth/session";

/** Called right after a successful `signIn.email()`, while the new session cookie is already set. */
export async function recordSignInAction(): Promise<void> {
  const session = await requireSession();
  if (!session) return;
  await recordSignIn(session.user as { id: string; name?: string; email?: string; organizationId?: string }, clientOf({ headers: await headers() }));
}

/** Called before `signOut()`, while the session being ended is still the caller's own. */
export async function recordSignOutAction(): Promise<void> {
  const session = await requireSession();
  if (!session) return;
  await recordSignOut(session.user as { id: string; name?: string; email?: string; organizationId?: string });
}
