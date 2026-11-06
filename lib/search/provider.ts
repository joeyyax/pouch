/**
 * Typo-tolerant search over what the dashboard searches, with Postgres as the floor.
 *
 * A provider only adds matches. Every caller keeps its own ILIKE predicate and ORs the provider's
 * ids into it inside the organization's own WHERE, so an index that lags, drops a write or is down
 * loses fuzzy matches and nothing else.
 */
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";
import type { SearchDocument, SearchIndexName } from "./documents";
import { MeilisearchProvider, meilisearchConfig } from "./meilisearch";

const log = logger.child("search");

export type SearchMode = "meilisearch" | "postgres";

export interface SearchQuery {
  organizationId: string;
  term: string;
  /** Only documents created at or after this. */
  since?: Date | undefined;
  /** Searchable attributes to match on. All of the index's when omitted. */
  on?: string[] | undefined;
}

export interface SearchHit {
  id: string;
  /** Array elements that matched, by attribute: the recipients a recipient search hit. */
  matched: Record<string, string[]>;
}

export interface SearchResult {
  mode: SearchMode;
  hits: SearchHit[];
  /** A configured index didn't answer, so this is Postgres alone. */
  degraded: boolean;
}

export interface SearchProvider {
  readonly mode: SearchMode;
  search(index: SearchIndexName, query: SearchQuery): Promise<SearchResult>;
  upsert(index: SearchIndexName, documents: SearchDocument[]): Promise<void>;
  remove(index: SearchIndexName, ids: string[]): Promise<void>;
  removeOrganization(organizationId: string): Promise<void>;
  /** Empties the index, for a reindex from scratch. */
  clear(index: SearchIndexName): Promise<void>;
}

/** Search off: every caller's ILIKE is the whole answer. */
export const postgresSearch: SearchProvider = {
  mode: "postgres",
  search: async () => ({ mode: "postgres", hits: [], degraded: false }),
  upsert: async () => {},
  remove: async () => {},
  removeOrganization: async () => {},
  clear: async () => {},
};

let override: SearchProvider | null = null;
let cached: { signature: string; provider: SearchProvider } | null = null;

export function searchProvider(): SearchProvider {
  if (override) return override;
  const config = meilisearchConfig();
  if (!config) return postgresSearch;
  const signature = JSON.stringify(config);
  if (cached?.signature !== signature) cached = { signature, provider: new MeilisearchProvider(config) };
  return cached.provider;
}

/** Tests swap the provider; null restores the one the environment picks. */
export function setSearchProvider(provider: SearchProvider | null): void {
  override = provider;
  cached = null;
}

const inFlight = new Set<Promise<void>>();

/** Runs an index write without making anyone wait on it or fail because of it. */
export function syncInBackground(label: string, write: (provider: SearchProvider) => Promise<void>): void {
  const provider = searchProvider();
  if (provider.mode === "postgres") return;
  const pending = write(provider)
    .catch((err: unknown) => log.warn(`search ${label} failed: ${safeErrorMessage(err)}`))
    .finally(() => inFlight.delete(pending));
  inFlight.add(pending);
}

/** Resolves once every background write started so far has finished or failed. */
export async function settleSearchWrites(): Promise<void> {
  while (inFlight.size > 0) await Promise.all(inFlight);
}
