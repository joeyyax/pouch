/**
 * Which ways into the dashboard are on. A method that's off is refused at its Better Auth
 * endpoints, and the write path keeps at least one on and every admin able to sign in.
 */
import { eq } from "drizzle-orm";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { accounts, passkeys, users } from "@/lib/db/schema";
import { systemMailReady } from "@/lib/mail/system";
import { resolveCurrentSettings } from "@/lib/settings/current";
import { effectiveValue, type SettingKey, type SettingState } from "@/lib/settings/registry";

export type SignInMethod = "password" | "passkey" | "magic_link";
export type SignInMethods = Record<SignInMethod, boolean>;

export const SIGN_IN_SETTINGS = {
  password: "sign_in_password",
  passkey: "sign_in_passkey",
  magic_link: "sign_in_magic_link",
} as const satisfies Record<SignInMethod, SettingKey>;

const METHODS = Object.keys(SIGN_IN_SETTINGS) as SignInMethod[];

const LABELS: Record<SignInMethod, string> = { password: "Password sign-in", passkey: "Passkey sign-in", magic_link: "Sign-in links" };

/** The settings' values. All three off, which only the environment or the config file can do, leaves the password on. */
export function signInMethodsFrom(states: Record<SettingKey, SettingState>): SignInMethods {
  const methods = Object.fromEntries(METHODS.map((method) => [method, effectiveValue<SettingKey>(states[SIGN_IN_SETTINGS[method]]) === true])) as SignInMethods;
  return METHODS.some((method) => methods[method]) ? methods : { ...methods, password: true };
}

/** Links alone without system mail would let nobody in, so the password comes back on until mail works. */
export async function enabledSignInMethods(): Promise<SignInMethods> {
  const methods = signInMethodsFrom(await resolveCurrentSettings());
  if (!methods.password && !methods.passkey && !(await systemMailReady())) return { ...methods, password: true };
  return methods;
}

/** Better Auth paths by the method they belong to. */
const METHOD_PATHS: Record<string, { method: SignInMethod }> = {
  "/sign-in/email": { method: "password" },
  "/request-password-reset": { method: "password" },
  "/reset-password": { method: "password" },
  "/passkey/generate-authenticate-options": { method: "passkey" },
  "/passkey/verify-authentication": { method: "passkey" },
  "/passkey/generate-register-options": { method: "passkey" },
  "/passkey/verify-registration": { method: "passkey" },
  "/sign-in/magic-link": { method: "magic_link" },
  "/magic-link/verify": { method: "magic_link" },
};

export const SIGN_IN_METHOD_DISABLED = "SIGN_IN_METHOD_DISABLED";

/** Refuses a method that's off at its own endpoints, over HTTP and through `auth.api`. */
export function signInMethodsGuard() {
  return {
    id: "sign-in-methods",
    hooks: {
      before: [
        {
          matcher: (ctx) => Object.hasOwn(METHOD_PATHS, ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const { method } = METHOD_PATHS[ctx.path]!;
            if ((await enabledSignInMethods())[method]) return;
            throw new APIError("FORBIDDEN", { code: SIGN_IN_METHOD_DISABLED, message: `${LABELS[method]} is turned off on this install.` });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

/** Addresses of accounts with no way in under `methods`. */
export async function accountsWithoutWayIn(methods: SignInMethods, { adminsOnly = false } = {}): Promise<string[]> {
  if (methods.magic_link && (await systemMailReady())) return [];
  const [people, withPassword, withPasskey] = await Promise.all([
    db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(adminsOnly ? eq(users.admin, true) : undefined)
      .orderBy(users.email),
    methods.password ? db.selectDistinct({ userId: accounts.userId }).from(accounts).where(eq(accounts.providerId, "credential")) : [],
    methods.passkey ? db.selectDistinct({ userId: passkeys.userId }).from(passkeys) : [],
  ]);
  const canSignIn = new Set([...withPassword, ...withPasskey].map((row) => row.userId));
  return people.filter((person) => !canSignIn.has(person.id)).map((person) => person.email);
}

/** Runs before a sign-in setting is stored: one method stays on, and no admin is left without a way in. */
export async function assertSignInStaysOpen(key: SettingKey, value: boolean): Promise<void> {
  const method = METHODS.find((candidate) => SIGN_IN_SETTINGS[candidate] === key);
  if (!method || value) return;
  const states = await resolveCurrentSettings();
  const next = Object.fromEntries(
    METHODS.map((candidate) => [candidate, candidate === method ? false : effectiveValue<SettingKey>(states[SIGN_IN_SETTINGS[candidate]]) === true]),
  ) as SignInMethods;

  if (!METHODS.some((candidate) => next[candidate])) {
    throw new ApiError("validation_failed", "At least one way to sign in stays on. Turn another on first.", { field: key });
  }
  const stranded = await accountsWithoutWayIn(next, { adminsOnly: true });
  if (stranded.length > 0) {
    const named = stranded.length > 3 ? `${stranded.slice(0, 3).join(", ")} and ${stranded.length - 3} more` : stranded.join(", ");
    throw new ApiError(
      "validation_failed",
      `${named} would have no way to sign in. An admin needs a password or passkey that stays on, or sign-in links with system mail set up.`,
      { field: key },
    );
  }
}

/** Per method that's on: accounts that sign in only that way, so turning it off would strand them. */
export async function strandedIfTurnedOff(): Promise<Partial<Record<SignInMethod, number>>> {
  const methods = await enabledSignInMethods();
  const already = new Set(await accountsWithoutWayIn(methods));
  const counts: Partial<Record<SignInMethod, number>> = {};
  for (const method of METHODS.filter((candidate) => methods[candidate])) {
    const without = await accountsWithoutWayIn({ ...methods, [method]: false });
    counts[method] = without.filter((email) => !already.has(email)).length;
  }
  return counts;
}
