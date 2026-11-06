/**
 * The dev-only account cast: `scripts/dev-data.ts` seeds these, and the login page's one-click
 * sign-in (development only) offers them. Every account shares one known password rather than
 * a real one, since nothing here is meant to exist outside a developer's own database.
 */

export const DEV_PASSWORD = "pouch-dev-cast";

export type DevAccountKey = "admin" | "owner" | "member" | "member2";

export interface DevAccountSpec {
  email: string;
  name: string;
}

/**
 * `admin` carries no membership — the service-wide admin flag reaches the admin screens, not
 * the inside of anyone's organization, and this account proves that axis independent of the org
 * roles. It gets into an organization by emulating one (#380). `owner` and
 * `member` sit in the primary dev org (`scripts/seed.ts`'s); `member2` sits in both it and
 * `DEV_SECOND_ORGANIZATION`, so its switcher is the one with something to switch between.
 */
export const DEV_ACCOUNTS: Record<DevAccountKey, DevAccountSpec> = {
  admin: { email: "admin@dev.pouch.local", name: "Olive Admin" },
  owner: { email: "owner@dev.pouch.local", name: "Owen Owner" },
  member: { email: "member@dev.pouch.local", name: "Mira Member" },
  member2: { email: "member2@dev.pouch.local", name: "Nadia Northgate" },
};

export const DEV_ACCOUNT_KEYS = Object.keys(DEV_ACCOUNTS) as DevAccountKey[];

export const DEV_SECOND_ORGANIZATION = { name: "Northgate", slug: "northgate" };

/**
 * The whole gate, shared by the login page (whether it queries and renders the list) and
 * `signInDevAccountAction` (whether it refuses). One predicate so the two can't drift —
 * see docs/decisions.md and the scope note against ever loosening auth config for QA instead.
 */
export function devSignInEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}
