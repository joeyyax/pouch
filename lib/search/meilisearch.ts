/** Meilisearch over plain HTTP. Works against Meilisearch itself or the search.example.org proxy. */
import { fetchWithTimeout } from "@/lib/fetch-timeout";
import { INDEX_SETTINGS, SEARCH_INDEXES, type SearchDocument, type SearchIndexName } from "./documents";
import type { SearchHit, SearchProvider, SearchQuery, SearchResult } from "./provider";

export interface MeilisearchConfig {
  url: string;
  apiKey: string | null;
  indexPrefix: string;
  /** How long a dashboard search waits before answering from Postgres alone. */
  timeoutMs: number;
}

/** Off unless `MEILISEARCH_URL` is set. */
export function meilisearchConfig(env: Record<string, string | undefined> = process.env): MeilisearchConfig | null {
  const url = env.MEILISEARCH_URL?.trim().replace(/\/+$/, "");
  if (!url) return null;
  const timeout = Number(env.MEILISEARCH_TIMEOUT_MS);
  return {
    url,
    apiKey: env.MEILISEARCH_API_KEY?.trim() || null,
    indexPrefix: env.MEILISEARCH_INDEX_PREFIX?.trim() || "pouch_",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 300,
  };
}

/** Most ids one search adds. Meilisearch's own default ceiling. */
const MAX_HITS = 1000;
const WRITE_TIMEOUT_MS = 5000;
/** After a failed search, how long searches skip the index rather than each wait out the timeout. */
const COOLDOWN_MS = 30_000;

/** A value inside a Meilisearch filter string. */
export function filterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The organization filter every search carries. It comes from the session, never the request. */
export function searchFilter(query: Pick<SearchQuery, "organizationId" | "since">): string {
  const parts = [`organization_id = ${filterValue(query.organizationId)}`];
  if (query.since) parts.push(`created_at >= ${Math.floor(query.since.getTime() / 1000)}`);
  return parts.join(" AND ");
}

interface RawHit {
  id: string;
  _matchesPosition?: Record<string, { indices?: number[] }[]>;
  [attribute: string]: unknown;
}

export class MeilisearchProvider implements SearchProvider {
  readonly mode = "meilisearch" as const;
  private downUntil = 0;
  private readonly ready = new Map<SearchIndexName, Promise<void>>();

  constructor(private readonly config: MeilisearchConfig) {}

  uid(index: SearchIndexName): string {
    return `${this.config.indexPrefix}${index}`;
  }

  async search(index: SearchIndexName, query: SearchQuery): Promise<SearchResult> {
    if (Date.now() < this.downUntil) return { mode: "postgres", hits: [], degraded: true };
    try {
      const body = {
        q: query.term,
        filter: searchFilter(query),
        limit: MAX_HITS,
        attributesToRetrieve: ["id", ...(query.on ?? [])],
        ...(query.on ? { attributesToSearchOn: query.on, showMatchesPosition: true } : {}),
      };
      const result = await this.request<{ hits: RawHit[] }>("POST", `/indexes/${this.uid(index)}/search`, body, this.config.timeoutMs);
      return { mode: "meilisearch", hits: result.hits.map((hit) => toHit(hit, query.on)), degraded: false };
    } catch {
      this.downUntil = Date.now() + COOLDOWN_MS;
      return { mode: "postgres", hits: [], degraded: true };
    }
  }

  async upsert(index: SearchIndexName, documents: SearchDocument[]): Promise<void> {
    if (documents.length === 0) return;
    await this.ensure(index);
    await this.request("POST", `/indexes/${this.uid(index)}/documents?primaryKey=id`, documents);
  }

  async remove(index: SearchIndexName, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.request("POST", `/indexes/${this.uid(index)}/documents/delete-batch`, ids);
  }

  async removeOrganization(organizationId: string): Promise<void> {
    for (const index of SEARCH_INDEXES) {
      await this.ensure(index);
      await this.request("POST", `/indexes/${this.uid(index)}/documents/delete`, {
        filter: `organization_id = ${filterValue(organizationId)}`,
      });
    }
  }

  async clear(index: SearchIndexName): Promise<void> {
    await this.ensure(index);
    await this.request("DELETE", `/indexes/${this.uid(index)}/documents`, undefined);
  }

  /** Creates the index with its settings once per process. Both calls are idempotent. */
  ensure(index: SearchIndexName): Promise<void> {
    let pending = this.ready.get(index);
    if (!pending) {
      pending = this.createIndex(index).catch((err: unknown) => {
        this.ready.delete(index);
        throw err;
      });
      this.ready.set(index, pending);
    }
    return pending;
  }

  private async createIndex(index: SearchIndexName): Promise<void> {
    await this.request("POST", "/indexes", { uid: this.uid(index), primaryKey: "id" }).catch((err: unknown) => {
      if (!(err instanceof MeilisearchError && err.code === "index_already_exists")) throw err;
    });
    await this.request("PATCH", `/indexes/${this.uid(index)}/settings`, INDEX_SETTINGS[index]);
  }

  private async request<T>(method: string, path: string, body: unknown, timeoutMs = WRITE_TIMEOUT_MS): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    const { response, text } = await fetchWithTimeout(
      `${this.config.url}${path}`,
      { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      timeoutMs,
      "Meilisearch",
    );
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const code = (parsed as { code?: string } | null)?.code ?? `http_${response.status}`;
      throw new MeilisearchError(code, `Meilisearch ${method} ${path.split("?")[0]} answered ${response.status} (${code}).`);
    }
    return parsed as T;
  }
}

export class MeilisearchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function toHit(raw: RawHit, on: string[] | undefined): SearchHit {
  const matched: Record<string, string[]> = {};
  for (const attribute of on ?? []) {
    const values = raw[attribute];
    const positions = raw._matchesPosition?.[attribute];
    if (!Array.isArray(values) || !positions) continue;
    const indices = new Set(positions.flatMap((position) => position.indices ?? []));
    matched[attribute] = [...indices].map((i) => values[i]).filter((value): value is string => typeof value === "string");
  }
  return { id: raw.id, matched };
}
