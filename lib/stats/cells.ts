/**
 * A cell is one UTC hour of messages for one domain, key and mode. The rollup stores cells and a
 * live read computes them with the same queries, so the two can't count differently.
 */
import { and, eq, gte, inArray, isNotNull, lt, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { messageEvents, messages } from "@/lib/db/schema";
import type { MessageHourlyStatsRow } from "@/lib/db/schema";
import { bucketSql, mergeHistogram, type LatencyHistogram } from "./histogram";

export type Cell = MessageHourlyStatsRow;

/** What a stats read counts: test mode is left out unless asked for. */
export type StatsMode = "live" | "test" | "all";

export interface StatsScope {
  organizationId: string;
  /** A domain-scoped key's domains. Empty reaches every domain. */
  domainIds: string[];
  domainId?: string | undefined;
  apiKeyId?: string | undefined;
  mode: StatsMode;
}

export const HOUR_MS = 3_600_000;

export function floorHour(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

export function ceilHour(at: Date): Date {
  return new Date(Math.ceil(at.getTime() / HOUR_MS) * HOUR_MS);
}

/** Start of the UTC hour `column` falls in, as epoch milliseconds. */
export function hourStartOf(column: AnyColumn): SQL<number> {
  return sql<number>`(extract(epoch from date_trunc('hour', ${column}, 'UTC')) * 1000)::bigint`.mapWith(Number);
}

const cellHour = hourStartOf(messages.createdAt);

/** The scope as a `messages` condition. */
export function messageScope(scope: StatsScope): SQL | undefined {
  return and(
    eq(messages.organizationId, scope.organizationId),
    scope.domainIds.length > 0 ? inArray(messages.domainId, scope.domainIds) : undefined,
    scope.domainId ? eq(messages.domainId, scope.domainId) : undefined,
    scope.apiKeyId ? eq(messages.apiKeyId, scope.apiKeyId) : undefined,
    scope.mode === "all" ? undefined : eq(messages.testMode, scope.mode === "test"),
  );
}

/** Created in [since, until). */
export function createdBetween(since: Date, until: Date): SQL {
  return and(gte(messages.createdAt, since), lt(messages.createdAt, until))!;
}

function cellKey(row: { organizationId: string | null; domainId: string; apiKeyId: string | null; testMode: boolean; hour: Date }): string {
  return `${row.organizationId ?? ""}|${row.domainId}|${row.apiKeyId ?? ""}|${row.testMode}|${row.hour.getTime()}`;
}

type SpanColumn = "queueLatency" | "providerLatency" | "endToEndLatency";
const SPANS: Record<string, SpanColumn> = { queue: "queueLatency", provider: "providerLatency", end_to_end: "endToEndLatency" };

/** Every cell `where` reaches, counted from `messages` and `message_events` now. */
export async function aggregateCells(where: SQL | undefined, executor: Executor = db): Promise<Cell[]> {
  const counted = await executor
    .select({
      organizationId: messages.organizationId,
      domainId: messages.domainId,
      apiKeyId: messages.apiKeyId,
      testMode: messages.testMode,
      hour: cellHour,
      total: sql<number>`count(*)::int`,
      queued: sql<number>`count(*) filter (where ${messages.status} = 'queued')::int`,
      sent: sql<number>`count(*) filter (where ${messages.status} = 'sent')::int`,
      deferred: sql<number>`count(*) filter (where ${messages.status} = 'deferred')::int`,
      delivered: sql<number>`count(*) filter (where ${messages.status} = 'delivered')::int`,
      bounced: sql<number>`count(*) filter (where ${messages.status} = 'bounced')::int`,
      complained: sql<number>`count(*) filter (where ${messages.status} = 'complained')::int`,
      failed: sql<number>`count(*) filter (where ${messages.status} = 'failed')::int`,
      abandoned: sql<number>`count(*) filter (where ${messages.status} = 'sent' and ${messages.abandonedAt} is not null)::int`,
      handedOver: sql<number>`count(*) filter (where ${messages.sentAt} is not null)::int`,
      attempts: sql<number>`coalesce(sum(${messages.attempts}) filter (where ${messages.sentAt} is not null), 0)::int`,
      lastSentAt: sql<Date | null>`max(${messages.sentAt})`.mapWith(messages.sentAt),
    })
    .from(messages)
    .where(where)
    .groupBy(messages.organizationId, messages.domainId, messages.apiKeyId, messages.testMode, cellHour);

  const cells = new Map<string, Cell>();
  for (const row of counted) {
    const cell: Cell = {
      ...row,
      hour: new Date(row.hour),
      lastSentAt: row.lastSentAt,
      queueLatency: null,
      providerLatency: null,
      endToEndLatency: null,
      reasons: {},
    };
    cells.set(cellKey(cell), cell);
  }
  if (cells.size === 0) return [];

  // One pass for all three spans. A negative span means the clocks disagreed, so it's left out.
  const ms = sql`span.ms`;
  const spans = await executor.execute<{
    organization_id: string | null;
    domain_id: string;
    api_key_id: string | null;
    test_mode: boolean;
    hour: number | string;
    span: string;
    bucket: number;
    count: number;
    min: number;
    max: number;
  }>(sql`
    select ${messages.organizationId} as organization_id, ${messages.domainId} as domain_id,
      ${messages.apiKeyId} as api_key_id, ${messages.testMode} as test_mode, ${cellHour} as hour,
      span.name as span, ${bucketSql(ms)} as bucket, count(*)::int as count,
      min(${ms})::float8 as min, max(${ms})::float8 as max
    from ${messages}
    cross join lateral (values
      ('queue', extract(epoch from (${messages.sentAt} - ${messages.createdAt})) * 1000),
      ('provider', extract(epoch from (${messages.deliveredAt} - ${messages.sentAt})) * 1000),
      ('end_to_end', extract(epoch from (${messages.deliveredAt} - ${messages.createdAt})) * 1000)
    ) as span(name, ms)
    where ${where ?? sql`true`} and span.ms is not null and span.ms >= 0
    group by 1, 2, 3, 4, 5, 6, 7
  `);
  for (const row of spans) {
    const cell = cells.get(
      cellKey({ organizationId: row.organization_id, domainId: row.domain_id, apiKeyId: row.api_key_id, testMode: row.test_mode, hour: new Date(Number(row.hour)) }),
    );
    const column = SPANS[row.span];
    if (!cell || !column) continue;
    const part: LatencyHistogram = { counts: { [String(row.bucket)]: Number(row.count) }, min: Number(row.min), max: Number(row.max) };
    cell[column] = mergeHistogram(cell[column], part);
  }

  const reasons = await executor
    .select({
      organizationId: messages.organizationId,
      domainId: messages.domainId,
      apiKeyId: messages.apiKeyId,
      testMode: messages.testMode,
      hour: cellHour,
      reason: messageEvents.reason,
      count: sql<number>`count(*)::int`,
    })
    .from(messageEvents)
    .innerJoin(messages, eq(messages.id, messageEvents.messageId))
    .where(and(where, sql`${messageEvents.status} in ('bounced', 'complained')`, isNotNull(messageEvents.reason)))
    .groupBy(messages.organizationId, messages.domainId, messages.apiKeyId, messages.testMode, cellHour, messageEvents.reason);
  for (const row of reasons) {
    const cell = cells.get(cellKey({ ...row, hour: new Date(row.hour) }));
    if (cell && row.reason !== null) cell.reasons[row.reason] = row.count;
  }

  return [...cells.values()];
}
