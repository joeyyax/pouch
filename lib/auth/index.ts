import { betterAuth } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins/magic-link";
import { passkey } from "@better-auth/passkey";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { clientOf } from "@/lib/api/client-ip";
import { brand } from "@/lib/brand";
import { logger } from "@/lib/logger";
import { guardLastCredential, refuseUnverifiedUser } from "./passkey";
import { MAGIC_LINK_TTL_SECONDS, sendMagicLinkMail } from "./magic-link";
import { recordSignIn, recordSignInFailed, type SignInMethod } from "./sign-in-activity";
import { runningSessionDays } from "./session-length";
import { signInMethodsGuard } from "./sign-in-methods";
import { invitationSessions } from "./invitation-session";
import { RESET_TOKEN_TTL_SECONDS, recordPasswordReset, runAuthTaskInBackground, sendPasswordResetMail } from "./password-reset";
import { safeErrorMessage } from "@/lib/errors/scrub";

/** Endpoints that start a session without the login form's own call to `recordSignInAction`. */
const SESSION_STARTERS: Record<string, SignInMethod> = {
  "/passkey/verify-authentication": "passkey",
  "/magic-link/verify": "magic_link",
};

/**
 * Records a passkey or link sign-in where the new session is known, so no client call can skip
 * it, and a refused `/sign-in/email`, so only a real attempt writes a row.
 */
const recordAuthActivity = createAuthMiddleware(async (ctx) => {
  const client = ctx.headers ? clientOf({ headers: ctx.headers }) : undefined;
  try {
    const method = SESSION_STARTERS[ctx.path];
    if (method) {
      const user = ctx.context.newSession?.user as { id: string; name?: string; email?: string; organizationId?: string } | undefined;
      if (user) await recordSignIn(user, client, method);
      return;
    }
    if (ctx.path !== "/sign-in/email" || !isAPIError(ctx.context.returned)) return;
    const email = (ctx.body as { email?: unknown } | undefined)?.email;
    if (typeof email === "string") await recordSignInFailed(email, client);
  } catch (error) {
    logger.child("auth").warn(`recording sign-in activity failed: ${safeErrorMessage(error)}`);
  }
});

const DAY_SECONDS = 60 * 60 * 24;

function build() {
  const sessionSeconds = runningSessionDays() * DAY_SECONDS;
  return betterAuth({
    appName: brand.name,
    baseURL: process.env.APP_URL || undefined,
    secret: process.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        passkey: schema.passkeys,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      sendResetPassword: sendPasswordResetMail,
      onPasswordReset: recordPasswordReset,
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
    },
    // Reset tokens are stored hashed, so a database read can't redeem one.
    verification: { storeIdentifier: { default: "plain", overrides: { "reset-password:": "hashed" } } },
    user: {
      additionalFields: {
        // Server-assigned. A client can't set its own organization at sign-up.
        organizationId: { type: "string", required: true, input: false },
        // Server-assigned. Exposed on the session so callers don't need a separate query for it.
        admin: { type: "boolean", required: false, input: false, defaultValue: false },
        // Set only through user settings, which validates it.
        timeZone: { type: "string", required: false, input: false },
      },
    },
    // nextCookies last: it applies Set-Cookie headers from a server-side auth.api call
    // (the dev sign-in shortcut) through next/headers, the way a client call gets them
    // from the fetch response instead.
    plugins: [
      passkey({
        authenticatorSelection: { userVerification: "required" },
        authentication: { afterVerification: refuseUnverifiedUser },
      }),
      // Never creates an account. The stored token is a hash of the emailed one.
      magicLink({ sendMagicLink: sendMagicLinkMail, disableSignUp: true, expiresIn: MAGIC_LINK_TTL_SECONDS, storeToken: "hashed" }),
      signInMethodsGuard(),
      invitationSessions(),
      nextCookies(),
    ],
    hooks: { before: guardLastCredential, after: recordAuthActivity },
    // Refreshed after a day of use, or halfway through a one-day session.
    session: { expiresIn: sessionSeconds, updateAge: Math.min(DAY_SECONDS, sessionSeconds / 2) },
    advanced: {
      useSecureCookies: process.env.NODE_ENV === "production",
      backgroundTasks: { handler: runAuthTaskInBackground },
    },
  });
}

type BetterAuth = ReturnType<typeof build>;

let instance: BetterAuth | null = null;

/** Built on first use so the production build doesn't need a database connection. */
function connect(): BetterAuth {
  if (!instance) instance = build();
  return instance;
}

export const auth = new Proxy({} as BetterAuth, {
  get(_target, prop) {
    return (connect() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
