import { Resolver } from "node:dns/promises";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";

/**
 * Resolves what a record's zone currently publishes and compares it against what Pouch wants,
 * live and server-side. This is separate from the provider's own verification: the provider
 * says whether it's satisfied, this says what the zone currently holds. Only the provider
 * decides a domain is verified.
 */

const LOOKUP_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 20_000;

/** Public resolvers rather than the host's: a resolver that filters or caches stale answers
 * turns a published record into a false "missing", the one verdict an operator acts on. */
const DEFAULT_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];

/** `DNS_RESOLVERS` overrides the default pair — a comma-separated list of IP addresses. */
function dnsServers(): string[] {
  const configured = (process.env.DNS_RESOLVERS ?? "")
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_DNS_SERVERS;
}

export type DnsVerdict = "match" | "different" | "missing" | "unresolved";

/**
 * Why a record couldn't be read. `not_found` is a definitive negative answer (nothing published
 * at this name) — distinct from `timeout` or `servfail`, where the resolver couldn't tell us
 * either way. A propagating record and a genuinely absent one both answer `not_found`; there's
 * no DNS signal that tells them apart.
 */
export type DnsErrorKind = "not_found" | "timeout" | "servfail" | "lookup_failed";

export interface DnsRecordCheck {
  record: ProposedDnsRecord;
  verdict: DnsVerdict;
  /** What currently resolves at this name, formatted for display. Empty on `missing`/`unresolved`. */
  observed: string[];
  /** Set only when verdict is `unresolved`. */
  errorKind: DnsErrorKind | null;
}

type LookupOutcome = { ok: true; observed: string[] } | { ok: false; errorKind: DnsErrorKind };

const cache = new Map<string, { expires: number; outcome: LookupOutcome }>();

/** Clears the lookup cache. Tests only. */
export function resetDnsCheckCache(): void {
  cache.clear();
}

function stripDot(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

function cacheKey(record: ProposedDnsRecord): string {
  return `${record.type}:${record.name.toLowerCase()}`;
}

function classifyError(err: unknown): DnsErrorKind {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEOUT" || code === "ECANCELLED") return "timeout";
  if (code === "ENOTFOUND" || code === "ENODATA") return "not_found";
  if (code === "ESERVFAIL") return "servfail";
  return "lookup_failed";
}

/** Races a resolver call against a timeout, cancelling the resolver's outstanding query if it fires. */
async function withTimeout<T>(resolver: Resolver, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      resolver.cancel();
      reject(Object.assign(new Error("DNS lookup timed out"), { code: "ETIMEOUT" }));
    }, LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function lookup(record: ProposedDnsRecord): Promise<LookupOutcome> {
  const resolver = new Resolver();
  resolver.setServers(dnsServers());
  try {
    if (record.type === "CNAME") {
      const answers = await withTimeout(resolver, resolver.resolveCname(record.name));
      return { ok: true, observed: answers.map(stripDot) };
    }
    if (record.type === "MX") {
      const answers = await withTimeout(resolver, resolver.resolveMx(record.name));
      return { ok: true, observed: answers.map((a) => `${a.priority} ${stripDot(a.exchange)}`) };
    }
    const answers = await withTimeout(resolver, resolver.resolveTxt(record.name));
    return { ok: true, observed: answers.map((chunks) => chunks.join("")) };
  } catch (err) {
    return { ok: false, errorKind: classifyError(err) };
  }
}

async function cachedLookup(record: ProposedDnsRecord): Promise<LookupOutcome> {
  const key = cacheKey(record);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.outcome;

  const outcome = await lookup(record);
  cache.set(key, { expires: now + CACHE_TTL_MS, outcome });
  return outcome;
}

function wantedValue(record: ProposedDnsRecord): string {
  return record.type === "MX" ? `${record.priority ?? 10} ${stripDot(record.value.toLowerCase())}` : record.value;
}

function matches(record: ProposedDnsRecord, observed: string): boolean {
  if (record.type === "TXT") return observed === record.value;
  return stripDot(observed).toLowerCase() === wantedValue(record).toLowerCase();
}

/** Resolves one record and compares it against what Pouch wants there. Cached briefly. */
export async function checkRecord(record: ProposedDnsRecord): Promise<DnsRecordCheck> {
  const outcome = await cachedLookup(record);
  if (!outcome.ok) {
    return {
      record,
      observed: [],
      errorKind: outcome.errorKind,
      verdict: outcome.errorKind === "not_found" ? "missing" : "unresolved",
    };
  }
  const verdict: DnsVerdict = outcome.observed.some((value) => matches(record, value)) ? "match" : "different";
  return { record, observed: outcome.observed, errorKind: null, verdict };
}

/** Resolves every record in parallel, so one slow name doesn't hold up the rest. */
export async function checkRecords(records: ProposedDnsRecord[]): Promise<DnsRecordCheck[]> {
  return Promise.all(records.map(checkRecord));
}

/** The TXT strings published at `name`, cached briefly: empty when there are none, null when the lookup couldn't tell. */
export async function readTxt(name: string): Promise<string[] | null> {
  const outcome = await cachedLookup({ type: "TXT", name, value: "", required: false });
  if (outcome.ok) return outcome.observed;
  return outcome.errorKind === "not_found" ? [] : null;
}
