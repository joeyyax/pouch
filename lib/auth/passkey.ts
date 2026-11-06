/**
 * Passkey sign-in is a whole credential, so it needs user verification and the last one can't be
 * removed from a password-less account. The plugin fixes `userVerification` at "preferred" for
 * authentication and has no option for it, so the options response is rewritten here and the
 * assertion is checked again after the plugin verifies it.
 */
import { and, eq } from "drizzle-orm";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { db } from "@/lib/db";
import { accounts, passkeys } from "@/lib/db/schema";

export const PASSKEY_OPTIONS_PATH = "/api/auth/passkey/generate-authenticate-options";

export const LAST_CREDENTIAL_MESSAGE = "This is the only way into this account. Add a password or another passkey before removing it.";

/** The plugin's authentication options with `userVerification` raised to "required". Headers, cookies included, are kept. */
export async function requireUserVerification(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const options = (await response.clone().json()) as Record<string, unknown>;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json({ ...options, userVerification: "required" }, { status: response.status, headers });
}

/** Runs after the plugin verifies an assertion, before a session starts. */
export function refuseUnverifiedUser({ verification }: { verification: { authenticationInfo: { userVerified: boolean } } }): void {
  if (!verification.authenticationInfo.userVerified) {
    throw new APIError("BAD_REQUEST", { message: "The passkey didn't verify the user." });
  }
}

/** Before the plugin's delete endpoint, which a client can call directly, around the dashboard's own check. */
export const guardLastCredential = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/passkey/delete-passkey") return;
  const session = await getSessionFromCtx(ctx);
  if (!session) return;
  const userId = session.user.id;

  const held = await db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, userId)).limit(2);
  if (held.length > 1) return;
  const [password] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
    .limit(1);
  if (!password) throw new APIError("BAD_REQUEST", { message: LAST_CREDENTIAL_MESSAGE });
});
