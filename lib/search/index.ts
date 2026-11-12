/** What the rest of the app calls: fuzzy matches for a screen's search, and the writes that keep the index current. */
import type { MessageRow, SuppressionRow } from "@/lib/db/schema";
import { isOwned, messageDocument, suppressionDocument, type SearchIndexName } from "./documents";
import { searchProvider, syncInBackground, type SearchQuery } from "./provider";

export { searchProvider, setSearchProvider, settleSearchWrites, postgresSearch, type SearchProvider, type SearchMode } from "./provider";

export interface FuzzyMatches {
  ids: string[];
  /** Matched array elements, by attribute. */
  matched: Record<string, string[]>;
  /** A configured index didn't answer, so the screen shows exact matches only. */
  degraded: boolean;
}

/** Ids a typo-tolerant search adds to a screen's own exact match. Empty when search is off or down. */
export async function fuzzyMatches(index: SearchIndexName, query: SearchQuery): Promise<FuzzyMatches> {
  const result = await searchProvider().search(index, query);
  const matched: Record<string, string[]> = {};
  for (const hit of result.hits) {
    for (const [attribute, values] of Object.entries(hit.matched)) {
      matched[attribute] = [...(matched[attribute] ?? []), ...values];
    }
  }
  return { ids: result.hits.map((hit) => hit.id), matched, degraded: result.degraded };
}

type IndexedMessage = Pick<MessageRow, "id" | "organizationId" | "domainId" | "fromAddress" | "subject" | "recipients" | "tags" | "createdAt">;

export function indexMessages(rows: IndexedMessage[], domainName: string): void {
  const owned = rows.filter(isOwned);
  if (owned.length === 0) return;
  syncInBackground("message upsert", (provider) => provider.upsert("messages", owned.map((row) => messageDocument(row, domainName))));
}

type IndexedSuppression = Pick<SuppressionRow, "id" | "organizationId" | "address" | "createdAt">;

export function indexSuppressions(rows: IndexedSuppression[]): void {
  const owned = rows.filter(isOwned);
  if (owned.length === 0) return;
  syncInBackground("suppression upsert", (provider) => provider.upsert("suppressions", owned.map(suppressionDocument)));
}

export function unindexSuppressions(ids: string[]): void {
  if (ids.length === 0) return;
  syncInBackground("suppression delete", (provider) => provider.remove("suppressions", ids));
}

export function unindexMessages(ids: string[]): void {
  if (ids.length === 0) return;
  syncInBackground("message delete", (provider) => provider.remove("messages", ids));
}

export function unindexOrganization(organizationId: string): void {
  syncInBackground("organization delete", (provider) => provider.removeOrganization(organizationId));
}
