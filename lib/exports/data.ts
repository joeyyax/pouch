/**
 * Suppressions and domains, NDJSON, whole organization. Unlike the message log these aren't
 * filtered by the messages screen's scope — a suppression list or a domain's DNS records
 * aren't something the messages filter bar narrows today, and an operator asking "get my
 * data out" wants the complete list either way.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, suppressions } from "@/lib/db/schema";
import { EXPORT_BATCH_SIZE } from "./limits";

/** Row count across both tables, for the audit record — cheap, and both tables are small. */
export async function countOrganizationData(organizationId: string): Promise<number> {
  const [suppressionCount] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(suppressions)
    .where(eq(suppressions.organizationId, organizationId));
  const [domainCount] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(domains)
    .where(eq(domains.organizationId, organizationId));
  return (suppressionCount?.total ?? 0) + (domainCount?.total ?? 0);
}

export async function* organizationDataNdjsonLines(organizationId: string): AsyncGenerator<string> {
  // A value cursor, not keysetAfter: a suppression removed mid-export would end the walk there.
  let cursor: { at: string; id: string } | null = null;
  for (;;) {
    const suppressionRows: { row: typeof suppressions.$inferSelect; at: string }[] = await db
      .select({ row: suppressions, at: sql<string>`${suppressions.createdAt}::text` })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.organizationId, organizationId),
          cursor
            ? sql`(${suppressions.createdAt}, ${suppressions.id}) > (${cursor.at}::timestamptz, ${cursor.id})`
            : undefined,
        ),
      )
      .orderBy(asc(suppressions.createdAt), asc(suppressions.id))
      .limit(EXPORT_BATCH_SIZE);

    for (const { row } of suppressionRows) {
      yield `${JSON.stringify({
        type: "suppression",
        id: row.id,
        address: row.address,
        reason: row.reason,
        detail: row.detail,
        source_message_id: row.sourceMessageId,
        created_at: row.createdAt.toISOString(),
      })}\n`;
    }

    if (suppressionRows.length < EXPORT_BATCH_SIZE) break;
    const last = suppressionRows[suppressionRows.length - 1]!;
    cursor = { at: last.at, id: last.row.id };
  }

  const domainRows = await db
    .select()
    .from(domains)
    .where(eq(domains.organizationId, organizationId))
    .orderBy(asc(domains.createdAt), asc(domains.id));

  for (const row of domainRows) {
    yield `${JSON.stringify({
      type: "domain",
      id: row.id,
      name: row.name,
      status: row.status,
      dns_records: row.dnsRecords,
      layout: row.layout,
      verified_at: row.verifiedAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
    })}\n`;
  }
}
