import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import type { KeyDomainOption } from "@/lib/dashboard/views/keys";

/** Every domain in the organization as id, name and verified, for a picker. */
export async function listDomainOptions(organizationId: string): Promise<KeyDomainOption[]> {
  const rows = await db
    .select({ id: domains.id, name: domains.name, status: domains.status })
    .from(domains)
    .where(eq(domains.organizationId, organizationId))
    .orderBy(asc(domains.name));
  return rows.map((row) => ({ id: row.id, name: row.name, verified: row.status === "verified" }));
}
