import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, domains, messages } from "@/lib/db/schema";
import type { SetupState } from "@/lib/dashboard/views/setup";

/** What the overview's setup checklist reads: domains, active keys and whether anything has sent. */
export async function readSetupState(organizationId: string, assigned: boolean): Promise<SetupState> {
  const [domainRows, [keys], [sent], [live]] = await Promise.all([
    db
      .select({ id: domains.id, name: domains.name, status: domains.status })
      .from(domains)
      .where(eq(domains.organizationId, organizationId))
      .orderBy(asc(domains.createdAt), asc(domains.id)),
    db
      .select({
        count: sql<number>`count(*)::int`,
        live: sql<number>`count(*) filter (where ${apiKeys.mode} = 'live')::int`,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.organizationId, organizationId), isNull(apiKeys.revokedAt))),
    db.select({ id: messages.id }).from(messages).where(eq(messages.organizationId, organizationId)).limit(1),
    db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.organizationId, organizationId), eq(messages.testMode, false)))
      .limit(1),
  ]);

  return {
    assigned,
    domainCount: domainRows.length,
    unverified: domainRows.find((row) => row.status !== "verified") ?? null,
    verified: domainRows.find((row) => row.status === "verified") ?? null,
    keyCount: keys?.count ?? 0,
    liveKeyCount: keys?.live ?? 0,
    sent: live ? "live" : sent ? "test" : null,
  };
}
