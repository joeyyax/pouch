import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { listMemberships } from "@/lib/db/schema";
import { csvRow } from "@/lib/exports/csv";

const HEADER = ["address", "status", "source", "confirmed_at", "confirmed_by", "unsubscribed_at", "created_at", "attributes"];

/** Every member of a list as CSV, in the header the importer reads back. */
export async function memberCsv(listId: string): Promise<string> {
  const members = await db
    .select()
    .from(listMemberships)
    .where(eq(listMemberships.listId, listId))
    .orderBy(asc(listMemberships.createdAt), asc(listMemberships.id));

  let body = csvRow(HEADER);
  for (const member of members) {
    body += csvRow([
      member.address,
      member.status,
      member.source,
      member.confirmedAt?.toISOString() ?? null,
      member.confirmedBy,
      member.unsubscribedAt?.toISOString() ?? null,
      member.createdAt.toISOString(),
      JSON.stringify(member.attributes),
    ]);
  }
  return body;
}

/** A download header that survives quotes and non-ASCII in the list's name. */
export function memberCsvHeaders(listName: string): Record<string, string> {
  const ascii = listName.replace(/[^A-Za-z0-9 ._-]+/g, "").trim() || "list";
  return {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${ascii}.csv"; filename*=UTF-8''${encodeURIComponent(`${listName}.csv`)}`,
    "cache-control": "no-store",
  };
}
