/**
 * Reads the seeded dev cast (`lib/dev/seed-accounts.ts`) back out of the database for display
 * on the login page — name, organization and role, never guessed from the spec alone, since
 * a membership only exists once `pnpm dev:data` has actually run. Server-only: imported by
 * the login page, never by a client component.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, organizations, users } from "@/lib/db/schema";
import { DEV_ACCOUNTS, DEV_ACCOUNT_KEYS, type DevAccountKey } from "./seed-accounts";

export interface DevAccountOption {
  key: DevAccountKey;
  name: string;
  org: string;
  role: string;
}

const ROLE_LABELS: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** Accounts that don't exist yet (seed not run) are left off the list rather than shown broken. */
export async function listDevAccounts(): Promise<DevAccountOption[]> {
  const emails = DEV_ACCOUNT_KEYS.map((key) => DEV_ACCOUNTS[key].email);
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name, admin: users.admin })
    .from(users)
    .where(inArray(users.email, emails));
  if (rows.length === 0) return [];

  const byEmail = new Map(rows.map((row) => [row.email, row]));

  const membershipRows = await db
    .select({ userId: memberships.userId, role: memberships.role, orgName: organizations.name })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(
      inArray(
        memberships.userId,
        rows.map((row) => row.id),
      ),
    );
  const membershipByUser = new Map(membershipRows.map((row) => [row.userId, row]));

  const options: DevAccountOption[] = [];
  for (const key of DEV_ACCOUNT_KEYS) {
    const row = byEmail.get(DEV_ACCOUNTS[key].email);
    if (!row) continue;

    const membership = membershipByUser.get(row.id);
    if (row.admin) {
      options.push({ key, name: row.name, org: membership?.orgName ?? "No organization", role: "Admin" });
      continue;
    }

    if (!membership) continue;
    options.push({ key, name: row.name, org: membership.orgName, role: ROLE_LABELS[membership.role] ?? membership.role });
  }
  return options;
}
