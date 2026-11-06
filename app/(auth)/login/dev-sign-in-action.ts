"use server";

/**
 * Signs in as one of the seeded dev accounts (`lib/dev/seed-accounts.ts`), through the same
 * Better Auth credential check `signIn.email()` uses from the form — nothing here mints a
 * session by hand. `nextCookies()` on `auth` (see `lib/auth/index.ts`) applies the resulting
 * session cookie through `next/headers`, the way a client call gets it from the fetch response.
 *
 * Gated on `NODE_ENV` inside the action, not only by the page hiding the list: a POST straight
 * to this action in production refuses the same way.
 */
import { auth } from "@/lib/auth";
import { DEV_ACCOUNTS, DEV_PASSWORD, devSignInEnabled, type DevAccountKey } from "@/lib/dev/seed-accounts";

export async function signInDevAccountAction(key: string): Promise<{ ok: boolean }> {
  if (!devSignInEnabled()) return { ok: false };
  if (!Object.hasOwn(DEV_ACCOUNTS, key)) return { ok: false };

  const account = DEV_ACCOUNTS[key as DevAccountKey];
  try {
    await auth.api.signInEmail({ body: { email: account.email, password: DEV_PASSWORD } });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
