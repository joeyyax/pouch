import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/** Deletes up to `limit` reports older than their organization's body retention, rows and all. Returns how many. */
export async function purgeExpiredReports(now: Date, limit: number): Promise<number> {
  const deleted = await db.execute<{ id: string }>(sql`
    delete from dmarc_reports
    where id in (
      select r.id
      from dmarc_reports r
      join organizations o on o.id = r.organization_id
      where r.received_at < ${now.toISOString()}::timestamptz - make_interval(days => o.body_retention_days)
      order by r.received_at
      limit ${limit}
    )
    returning id
  `);
  return deleted.length;
}
