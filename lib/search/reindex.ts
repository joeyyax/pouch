/** Copies every message and suppression into the index, for a first fill or a repair. */
import { and, asc, eq, gt, isNotNull, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messages, suppressions, type MessageRow, type SuppressionRow } from "@/lib/db/schema";
import { isOwned, messageDocument, suppressionDocument, SEARCH_INDEXES, type SearchIndexName } from "./documents";
import type { SearchProvider } from "./provider";

const CHUNK = 1000;

export interface ReindexOptions {
  organizationId?: string | undefined;
  /** Empties each index first, dropping documents for rows deleted while the index was unreachable. */
  fresh?: boolean | undefined;
  log?: (line: string) => void;
}

export async function reindex(provider: SearchProvider, options: ReindexOptions = {}): Promise<Record<SearchIndexName, number>> {
  const log = options.log ?? (() => {});
  if (options.fresh) {
    if (options.organizationId) await provider.removeOrganization(options.organizationId);
    else for (const index of SEARCH_INDEXES) await provider.clear(index);
  }

  const counts: Record<SearchIndexName, number> = { messages: 0, suppressions: 0 };

  let after: string | null = null;
  for (;;) {
    const rows: { message: MessageRow; domainName: string }[] = await db
      .select({ message: messages, domainName: domains.name })
      .from(messages)
      .innerJoin(domains, eq(domains.id, messages.domainId))
      .where(and(scope(messages.organizationId, options.organizationId), after ? gt(messages.id, after) : undefined))
      .orderBy(asc(messages.id))
      .limit(CHUNK);
    if (rows.length === 0) break;
    await provider.upsert("messages", rows.flatMap((row) => (isOwned(row.message) ? [messageDocument(row.message, row.domainName)] : [])));
    counts.messages += rows.length;
    after = rows[rows.length - 1]!.message.id;
    log(`messages: ${counts.messages}`);
  }

  let afterSuppression: string | null = null;
  for (;;) {
    const rows: SuppressionRow[] = await db
      .select()
      .from(suppressions)
      .where(
        and(
          scope(suppressions.organizationId, options.organizationId),
          afterSuppression ? gt(suppressions.id, afterSuppression) : undefined,
        ),
      )
      .orderBy(asc(suppressions.id))
      .limit(CHUNK);
    if (rows.length === 0) break;
    await provider.upsert("suppressions", rows.filter(isOwned).map(suppressionDocument));
    counts.suppressions += rows.length;
    afterSuppression = rows[rows.length - 1]!.id;
    log(`suppressions: ${counts.suppressions}`);
  }

  return counts;
}

function scope(column: typeof messages.organizationId | typeof suppressions.organizationId, organizationId: string | undefined): SQL | undefined {
  return organizationId ? eq(column, organizationId) : isNotNull(column);
}
