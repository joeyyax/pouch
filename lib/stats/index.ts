/** `GET /v1/stats`: what the overview, the volume strips and the domain and key trends read. */
import { and, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { apiKeys, domainDailyStats, domains, inboundMessages } from "@/lib/db/schema";
import type { MessageStatus } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import type { KeyMode } from "@/lib/api/keys";
import { selectShape, type Selection } from "@/lib/api/shape";
import { queueDepth, type QueueDepth } from "@/lib/messages/queue-depth";
import { statsShape, STATS_WINDOWS, type StatsWindow } from "@/lib/schemas/stats";
import { utcDay } from "@/lib/domains/daily-stats";
import { hourStartOf, HOUR_MS, type Cell, type StatsMode, type StatsScope } from "./cells";
import { histogramCount, mergeHistogram, quantile, type LatencyHistogram } from "./histogram";
import { readCells } from "./read";

export type { StatsMode, StatsScope };

const DAY_MS = 24 * HOUR_MS;
const REASONS_RETURNED = 20;

export interface StatsCaller {
  organizationId: string;
  domainIds: string[];
  /** A test key counts test mail only. */
  mode?: KeyMode;
}

export interface StatsQuery {
  window?: StatsWindow | undefined;
  since?: Date | undefined;
  until?: Date | undefined;
  bucket?: "hour" | "day" | undefined;
  mode?: StatsMode | undefined;
  domain?: string | undefined;
  key?: string | undefined;
  status?: MessageStatus[] | undefined;
}

export interface StatusCounts {
  total: number;
  queued: number;
  sent: number;
  deferred: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  /** Sent, and the provider never reported back. Part of `sent`. */
  abandoned: number;
}

export interface StatsBucket extends StatusCounts {
  start: string;
}

export interface LatencyQuantiles {
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  count: number;
}

export interface DomainStats {
  domain_id: string;
  name: string;
  counts: StatusCounts;
  previous_total: number;
  queue_p95_ms: number | null;
  last_sent_at: string | null;
  /** Totals aligned with `buckets`. */
  buckets: number[];
}

export interface KeyStats {
  /** Null for mail sent without a key. */
  key_id: string | null;
  total: number;
  buckets: number[];
}

export interface DomainDay {
  domain_id: string;
  day: string;
  computed_at: string;
  delivered_count: number;
  delivery_ms: { min: number | null; p10: number | null; p25: number | null; p50: number | null; p75: number | null; p90: number | null; p99: number | null; max: number | null };
  hourly_volume: number[];
}

export interface SerializedQueue extends Omit<QueueDepth, "oldest_queued_at" | "oldest_due_at" | "oldest_held_at" | "held_by_domain"> {
  oldest_queued_at: string | null;
  oldest_due_at: string | null;
  oldest_held_at: string | null;
  held_by_domain: { domain_id: string; count: number; oldest_queued_at: string }[];
}

export interface StatsResponse {
  /** Buckets start at the hour or UTC day `since` falls in, and run to `until`. */
  window: { since: string; until: string; previous_since: string; previous_until: string; bucket: "hour" | "day" };
  mode: StatsMode;
  counts: StatusCounts;
  previous_counts: StatusCounts;
  /** Attempts per message that reached the provider. Null with none. */
  attempts: { per_send: number | null; previous_per_send: number | null };
  buckets: StatsBucket[];
  previous_buckets: StatsBucket[];
  latency: { queue: LatencyQuantiles; provider: LatencyQuantiles; end_to_end: LatencyQuantiles };
  domains: DomainStats[];
  keys: KeyStats[];
  reasons: { reason: string; count: number }[];
  queue: SerializedQueue;
  inbound: { total: number; buckets: number[] };
  domain_days: DomainDay[];
}

const STATUSES = ["queued", "sent", "deferred", "delivered", "bounced", "complained", "failed"] as const;

function emptyCounts(): StatusCounts {
  return { total: 0, queued: 0, sent: 0, deferred: 0, delivered: 0, bounced: 0, complained: 0, failed: 0, abandoned: 0 };
}

/** A cell's counts, narrowed to `status` when the read names some. */
function countsOf(cell: Cell, status: ReadonlySet<MessageStatus> | null): StatusCounts {
  if (!status) {
    const { total, queued, sent, deferred, delivered, bounced, complained, failed, abandoned } = cell;
    return { total, queued, sent, deferred, delivered, bounced, complained, failed, abandoned };
  }
  const counts = emptyCounts();
  for (const name of STATUSES) {
    if (!status.has(name)) continue;
    counts[name] = cell[name];
    counts.total += cell[name];
  }
  if (status.has("sent")) counts.abandoned = cell.abandoned;
  return counts;
}

function addCounts(into: StatusCounts, next: StatusCounts): void {
  for (const key of Object.keys(next) as (keyof StatusCounts)[]) into[key] += next[key];
}

/** Bucket starts from the unit `since` falls in, up to `until`. */
function bucketStarts(since: Date, until: Date, unit: "hour" | "day"): number[] {
  const step = unit === "hour" ? HOUR_MS : DAY_MS;
  const starts: number[] = [];
  for (let at = Math.floor(since.getTime() / step) * step; at < until.getTime(); at += step) starts.push(at);
  return starts;
}

/** Where each of a window's buckets starts, for the totals arrays aligned with them. `previous` for `previous_buckets`. */
export function bucketStartsOf(window: StatsResponse["window"], previous = false): string[] {
  const since = new Date(previous ? window.previous_since : window.since);
  const until = new Date(previous ? window.previous_until : window.until);
  return bucketStarts(since, until, window.bucket).map((at) => new Date(at).toISOString());
}

function bucketIndex(starts: number[], hour: Date, unit: "hour" | "day"): number {
  const step = unit === "hour" ? HOUR_MS : DAY_MS;
  return Math.floor((hour.getTime() - starts[0]!) / step);
}

function bucketsOf(cells: Cell[], starts: number[], unit: "hour" | "day", status: ReadonlySet<MessageStatus> | null): StatsBucket[] {
  const buckets = starts.map((start) => ({ start: new Date(start).toISOString(), ...emptyCounts() }));
  for (const cell of cells) {
    const bucket = buckets[bucketIndex(starts, cell.hour, unit)];
    if (bucket) addCounts(bucket, countsOf(cell, status));
  }
  return buckets;
}

function totalsOf(cells: Cell[], starts: number[], unit: "hour" | "day", status: ReadonlySet<MessageStatus> | null): number[] {
  const totals = starts.map(() => 0);
  for (const cell of cells) {
    const index = bucketIndex(starts, cell.hour, unit);
    if (index >= 0 && index < totals.length) totals[index]! += countsOf(cell, status).total;
  }
  return totals;
}

function sumCounts(cells: Cell[], status: ReadonlySet<MessageStatus> | null): StatusCounts {
  const counts = emptyCounts();
  for (const cell of cells) addCounts(counts, countsOf(cell, status));
  return counts;
}

function perSend(cells: Cell[]): number | null {
  let attempts = 0;
  let handedOver = 0;
  for (const cell of cells) {
    attempts += cell.attempts;
    handedOver += cell.handedOver;
  }
  return handedOver === 0 ? null : attempts / handedOver;
}

function quantiles(histogram: LatencyHistogram | null): LatencyQuantiles {
  return {
    p50_ms: quantile(histogram, 0.5),
    p95_ms: quantile(histogram, 0.95),
    p99_ms: quantile(histogram, 0.99),
    count: histogramCount(histogram),
  };
}

function merged(cells: Cell[], column: "queueLatency" | "providerLatency" | "endToEndLatency"): LatencyHistogram | null {
  let histogram: LatencyHistogram | null = null;
  for (const cell of cells) histogram = mergeHistogram(histogram, cell[column]);
  return histogram;
}

function groupBy<K>(cells: Cell[], keyOf: (cell: Cell) => K): Map<K, Cell[]> {
  const groups = new Map<K, Cell[]>();
  for (const cell of cells) {
    const key = keyOf(cell);
    const list = groups.get(key) ?? [];
    list.push(cell);
    groups.set(key, list);
  }
  return groups;
}

function iso(at: Date | null): string | null {
  return at ? at.toISOString() : null;
}

/** The caller's mode: a test key counts test mail and nothing else. */
function modeFor(caller: StatsCaller, asked: StatsMode | undefined): StatsMode {
  if (caller.mode !== "test") return asked ?? "live";
  if (asked && asked !== "test") throw new ApiError("key_not_scoped", "A test key reads test mail only.", { field: "mode" });
  return "test";
}

async function checkDomain(caller: StatsCaller, domainId: string): Promise<void> {
  const [row] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.organizationId, caller.organizationId), eq(domains.id, domainId)))
    .limit(1);
  if (!row) throw new ApiError("not_found", "No domain with that id.", { field: "domain" });
  if (caller.domainIds.length > 0 && !caller.domainIds.includes(domainId)) {
    throw new ApiError("key_not_scoped", "This key can't reach this domain.", { field: "domain" });
  }
}

async function checkKey(caller: StatsCaller, keyId: string): Promise<void> {
  const [row] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, caller.organizationId), eq(apiKeys.id, keyId)))
    .limit(1);
  if (!row) throw new ApiError("not_found", "No key with that id.", { field: "key" });
}

async function domainNames(organizationId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: domains.id, name: domains.name })
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), inArray(domains.id, ids)));
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function inboundTotals(scope: StatsScope, since: Date, until: Date, starts: number[], unit: "hour" | "day"): Promise<{ total: number; buckets: number[] }> {
  const hour = hourStartOf(inboundMessages.receivedAt);
  const rows = await db
    .select({ hour, count: sql<number>`count(*)::int` })
    .from(inboundMessages)
    .where(
      and(
        eq(inboundMessages.organizationId, scope.organizationId),
        scope.domainIds.length > 0 ? inArray(inboundMessages.domainId, scope.domainIds) : undefined,
        scope.domainId ? eq(inboundMessages.domainId, scope.domainId) : undefined,
        gte(inboundMessages.receivedAt, since),
        lt(inboundMessages.receivedAt, until),
      ),
    )
    .groupBy(hour);
  const buckets = starts.map(() => 0);
  let total = 0;
  for (const row of rows) {
    total += row.count;
    const index = bucketIndex(starts, new Date(row.hour), unit);
    if (index >= 0 && index < buckets.length) buckets[index]! += row.count;
  }
  return { total, buckets };
}

async function domainDays(scope: StatsScope, since: Date, until: Date): Promise<DomainDay[]> {
  // The rollup leaves test mode out, so it has nothing for a test read.
  if (scope.mode === "test") return [];
  const rows = await db
    .select()
    .from(domainDailyStats)
    .where(
      and(
        eq(domainDailyStats.organizationId, scope.organizationId),
        scope.domainIds.length > 0 ? inArray(domainDailyStats.domainId, scope.domainIds) : undefined,
        scope.domainId ? eq(domainDailyStats.domainId, scope.domainId) : undefined,
        gte(domainDailyStats.day, utcDay(since)),
        lte(domainDailyStats.day, utcDay(until)),
      ),
    )
    .orderBy(domainDailyStats.domainId, domainDailyStats.day);
  return rows.map((row) => ({
    domain_id: row.domainId,
    day: row.day,
    computed_at: row.computedAt.toISOString(),
    delivered_count: row.deliveredCount,
    delivery_ms: {
      min: row.deliveryMinMs,
      p10: row.deliveryP10Ms,
      p25: row.deliveryP25Ms,
      p50: row.deliveryP50Ms,
      p75: row.deliveryP75Ms,
      p90: row.deliveryP90Ms,
      p99: row.deliveryP99Ms,
      max: row.deliveryMaxMs,
    },
    hourly_volume: row.hourlyVolume,
  }));
}

/**
 * Message counts, latency and the queue for one window and the equal window before it. `now` is
 * for tests that pin the clock; a real read takes the database's.
 */
export async function readStats(
  caller: StatsCaller,
  query: StatsQuery = {},
  selection: Selection = selectShape(statsShape),
  at?: Date,
): Promise<Partial<StatsResponse>> {
  const now = at ?? (await dbNow());
  const until = query.since ? (query.until ?? now) : now;
  const since = query.since ?? new Date(now.getTime() - STATS_WINDOWS[query.window ?? "30d"] * DAY_MS);
  const length = until.getTime() - since.getTime();
  const previousSince = new Date(since.getTime() - length);
  const unit = query.bucket ?? (length <= DAY_MS ? "hour" : "day");
  const mode = modeFor(caller, query.mode);
  if (query.domain) await checkDomain(caller, query.domain);
  if (query.key) await checkKey(caller, query.key);
  if (selection.has("inbound") && mode === "test") {
    throw new ApiError("key_not_scoped", "Inbound mail is live only, so a test read has none.", { field: "include" });
  }

  const scope: StatsScope = { organizationId: caller.organizationId, domainIds: caller.domainIds, domainId: query.domain, apiKeyId: query.key, mode };
  const status = query.status?.length ? new Set(query.status) : null;
  const starts = bucketStarts(since, until, unit);
  const previousStarts = bucketStarts(previousSince, since, unit);

  const needsCurrent = ["counts", "attempts", "buckets", "latency", "domains", "keys", "reasons"].some((key) => selection.has(key));
  const needsPrevious = ["previous_counts", "attempts", "previous_buckets", "domains"].some((key) => selection.has(key));
  const [current, previous, queue, inbound, days] = await Promise.all([
    needsCurrent ? readCells(scope, since, until, now) : [],
    needsPrevious ? readCells(scope, previousSince, since, now) : [],
    selection.has("queue") ? queueDepth(scope, now) : null,
    selection.has("inbound") ? inboundTotals(scope, since, until, starts, unit) : null,
    selection.has("domain_days") ? domainDays(scope, since, until) : null,
  ]);

  const response: Partial<StatsResponse> = {
    window: {
      since: since.toISOString(),
      until: until.toISOString(),
      previous_since: previousSince.toISOString(),
      previous_until: since.toISOString(),
      bucket: unit,
    },
  };
  if (selection.has("mode")) response.mode = mode;
  if (selection.has("counts")) response.counts = sumCounts(current, status);
  if (selection.has("previous_counts")) response.previous_counts = sumCounts(previous, status);
  if (selection.has("attempts")) response.attempts = { per_send: perSend(current), previous_per_send: perSend(previous) };
  if (selection.has("buckets")) response.buckets = bucketsOf(current, starts, unit, status);
  if (selection.has("previous_buckets")) response.previous_buckets = bucketsOf(previous, previousStarts, unit, status);
  if (selection.has("latency")) {
    response.latency = {
      queue: quantiles(merged(current, "queueLatency")),
      provider: quantiles(merged(current, "providerLatency")),
      end_to_end: quantiles(merged(current, "endToEndLatency")),
    };
  }

  if (selection.has("domains")) {
    const currentByDomain = groupBy(current, (cell) => cell.domainId);
    const previousByDomain = groupBy(previous, (cell) => cell.domainId);
    const ids = [...new Set([...currentByDomain.keys(), ...previousByDomain.keys()])];
    const names = await domainNames(caller.organizationId, ids);
    response.domains = ids
      .map((id): DomainStats => {
        const cells = currentByDomain.get(id) ?? [];
        const before = previousByDomain.get(id) ?? [];
        let lastSentAt: Date | null = null;
        for (const cell of [...cells, ...before]) {
          if (cell.lastSentAt && (!lastSentAt || cell.lastSentAt > lastSentAt)) lastSentAt = cell.lastSentAt;
        }
        return {
          domain_id: id,
          name: names.get(id) ?? id,
          counts: sumCounts(cells, status),
          previous_total: sumCounts(before, status).total,
          queue_p95_ms: quantile(merged(cells, "queueLatency"), 0.95),
          last_sent_at: iso(lastSentAt),
          buckets: totalsOf(cells, starts, unit, status),
        };
      })
      .filter((row) => row.counts.total > 0 || row.previous_total > 0)
      .sort((a, b) => b.counts.total - a.counts.total || a.name.localeCompare(b.name));
  }

  if (selection.has("keys")) {
    response.keys = [...groupBy(current, (cell) => cell.apiKeyId)]
      .map(([keyId, cells]) => ({ key_id: keyId, total: sumCounts(cells, status).total, buckets: totalsOf(cells, starts, unit, status) }))
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total || (a.key_id ?? "").localeCompare(b.key_id ?? ""));
  }

  if (selection.has("reasons")) {
    const reasons = new Map<string, number>();
    for (const cell of current) for (const [reason, count] of Object.entries(cell.reasons)) reasons.set(reason, (reasons.get(reason) ?? 0) + count);
    response.reasons = [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, REASONS_RETURNED);
  }

  if (queue) {
    response.queue = {
      ...queue,
      oldest_queued_at: iso(queue.oldest_queued_at),
      oldest_due_at: iso(queue.oldest_due_at),
      oldest_held_at: iso(queue.oldest_held_at),
      held_by_domain: queue.held_by_domain.map((row) => ({ ...row, oldest_queued_at: row.oldest_queued_at.toISOString() })),
    };
  }
  if (inbound) response.inbound = inbound;
  if (days) response.domain_days = days;
  return response;
}
