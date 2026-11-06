/**
 * The message rows an export walks, in the messages screen's own filter shape (see
 * lib/messages/filters.ts MessageFilters) so a filtered export matches what the screen shows.
 *
 * Not a call into lib/dashboard/messages.ts: that adapter's listMessages caps at LIST_LIMIT
 * (100) for the screen's own page. An export walks past that cap on a keyset cursor, the same
 * `(created_at desc, id desc)` convention lib/activity/query.ts uses, so a row inserted mid-export
 * can't be skipped or repeated across a page boundary.
 */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messages } from "@/lib/db/schema";
import type { MessageRow } from "@/lib/db/schema";
import { messageListConditions } from "@/lib/dashboard/message-volume";
import type { MessageFilters } from "@/lib/messages/filters";
import { EXPORT_BATCH_SIZE } from "./limits";
import { keysetBefore } from "@/lib/db/keyset";

export interface ExportMessageRow {
  message: MessageRow;
  domainName: string;
}

/** The screen's own conditions (lib/dashboard/message-volume.ts), so an export can't drift from the list it came from. */
function baseWhere(organizationId: string, filters: MessageFilters): SQL | undefined {
  return messageListConditions(organizationId, filters, new Date(), { createdWindow: !filters.screenWindow });
}

/** How many rows this filter matches, so an export can refuse before it starts streaming. */
export async function countExportableMessages(organizationId: string, filters: MessageFilters): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(domains, eq(domains.id, messages.domainId))
    .where(and(baseWhere(organizationId, filters)));
  return row?.total ?? 0;
}

/** Walks every matching message, oldest page first, without holding the whole result in memory. */
export async function* iterateExportMessages(
  organizationId: string,
  filters: MessageFilters,
  batchSize = EXPORT_BATCH_SIZE,
): AsyncGenerator<ExportMessageRow> {
  let cursor: string | null = null;

  for (;;) {
    const cursorCondition: SQL | undefined = cursor
      ? keysetBefore({ table: messages, sort: messages.createdAt, id: messages.id }, cursor)
      : undefined;

    const rows: ExportMessageRow[] = await db
      .select({ message: messages, domainName: domains.name })
      .from(messages)
      .innerJoin(domains, eq(domains.id, messages.domainId))
      .where(and(baseWhere(organizationId, filters), cursorCondition))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(batchSize);

    if (rows.length === 0) return;

    for (const row of rows) yield row;

    const last = rows[rows.length - 1]!;
    cursor = last.message.id;
    if (rows.length < batchSize) return;
  }
}
