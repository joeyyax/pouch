/** Loaders the lists screens need beyond lib/lists. */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";

/** The name of the domain a list sends from. */
export async function listDomainName(organizationId: string, domainId: string): Promise<string> {
  const [row] = await db
    .select({ name: domains.name })
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), eq(domains.id, domainId)))
    .limit(1);
  return row?.name ?? domainId;
}
