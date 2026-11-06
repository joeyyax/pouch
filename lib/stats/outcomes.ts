/**
 * Outcome counts per domain for the stall guard and reputation: the rollup, with changed hours
 * counted live. The service's own mail counts toward the domain that sent it, since its provider saw it.
 */
import { and, eq, gte, inArray, isNull, lt, notInArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messageHourlyStats, messages } from "@/lib/db/schema";
import { EMPTY_COUNTS, type OutcomeCounts } from "@/lib/metrics/rates";
import { createdBetween, hourStartOf, HOUR_MS } from "./cells";
import { rolledSpan } from "./read";
import { OVERLAP_MS, readRollupState } from "./rollup";

export interface OutcomeScope {
  organizationId: string;
  /** Every domain when absent. */
  domainIds?: string[] | undefined;
}

export type OutcomesByDomain = Map<string, OutcomeCounts>;

const counted = {
  total: sql<number>`count(*)::int`,
  delivered: sql<number>`count(*) filter (where ${messages.status} = 'delivered')::int`,
  bounced: sql<number>`count(*) filter (where ${messages.status} = 'bounced')::int`,
  complained: sql<number>`count(*) filter (where ${messages.status} = 'complained')::int`,
  failed: sql<number>`count(*) filter (where ${messages.status} = 'failed')::int`,
  inFlight: sql<number>`count(*) filter (where ${messages.status} in ('sent', 'deferred'))::int`,
  queued: sql<number>`count(*) filter (where ${messages.status} = 'queued')::int`,
};

const summed = {
  total: sql<number>`sum(${messageHourlyStats.total})::int`,
  delivered: sql<number>`sum(${messageHourlyStats.delivered})::int`,
  bounced: sql<number>`sum(${messageHourlyStats.bounced})::int`,
  complained: sql<number>`sum(${messageHourlyStats.complained})::int`,
  failed: sql<number>`sum(${messageHourlyStats.failed})::int`,
  inFlight: sql<number>`sum(${messageHourlyStats.sent} + ${messageHourlyStats.deferred})::int`,
  queued: sql<number>`sum(${messageHourlyStats.queued})::int`,
};

/** The organization's own rows, and the service's on the organization's domains. */
function heldOrCarried(scope: OutcomeScope, organizationColumn: AnyColumn, domainColumn: AnyColumn): SQL {
  const ownDomains = db.select({ id: domains.id }).from(domains).where(eq(domains.organizationId, scope.organizationId));
  return or(eq(organizationColumn, scope.organizationId), and(isNull(organizationColumn), inArray(domainColumn, ownDomains)))!;
}

function messageScope(scope: OutcomeScope): SQL | undefined {
  return and(
    heldOrCarried(scope, messages.organizationId, messages.domainId),
    scope.domainIds ? inArray(messages.domainId, scope.domainIds) : undefined,
    eq(messages.testMode, false),
  );
}

async function live(scope: OutcomeScope, created: SQL[]): Promise<({ domainId: string } & OutcomeCounts)[]> {
  if (created.length === 0) return [];
  return db
    .select({ domainId: messages.domainId, ...counted })
    .from(messages)
    .where(and(messageScope(scope), or(...created)))
    .groupBy(messages.domainId);
}

function add(into: OutcomesByDomain, rows: ({ domainId: string } & OutcomeCounts)[]): void {
  for (const { domainId, ...counts } of rows) {
    const sum = into.get(domainId) ?? EMPTY_COUNTS;
    into.set(domainId, {
      total: sum.total + counts.total,
      delivered: sum.delivered + counts.delivered,
      bounced: sum.bounced + counts.bounced,
      complained: sum.complained + counts.complained,
      failed: sum.failed + counts.failed,
      inFlight: sum.inFlight + counts.inFlight,
      queued: sum.queued + counts.queued,
    });
  }
}

/** Messages created in [since, until), per domain. A domain with none in the window has no entry. */
export async function readOutcomes(scope: OutcomeScope, since: Date, until: Date, now: Date): Promise<OutcomesByDomain> {
  const byDomain: OutcomesByDomain = new Map();
  if (scope.domainIds?.length === 0 || since >= until) return byDomain;

  const state = await readRollupState();
  const { from, to } = rolledSpan(state, since, until, now);
  if (!state || from >= to) {
    add(byDomain, await live(scope, [createdBetween(since, until)]));
    return byDomain;
  }

  const changed = await db
    .selectDistinct({ hour: hourStartOf(messages.createdAt) })
    .from(messages)
    .where(
      and(
        messageScope(scope),
        gte(messages.updatedAt, new Date(state.ranAt.getTime() - OVERLAP_MS)),
        createdBetween(from, to),
      ),
    );
  const stale = changed.map((row) => new Date(row.hour));

  const [stored, counted] = await Promise.all([
    db
      .select({ domainId: messageHourlyStats.domainId, ...summed })
      .from(messageHourlyStats)
      .where(
        and(
          heldOrCarried(scope, messageHourlyStats.organizationId, messageHourlyStats.domainId),
          scope.domainIds ? inArray(messageHourlyStats.domainId, scope.domainIds) : undefined,
          eq(messageHourlyStats.testMode, false),
          gte(messageHourlyStats.hour, from),
          lt(messageHourlyStats.hour, to),
          stale.length > 0 ? notInArray(messageHourlyStats.hour, stale) : undefined,
        ),
      )
      .groupBy(messageHourlyStats.domainId),
    live(scope, [
      ...(since < from ? [createdBetween(since, from)] : []),
      ...(to < until ? [createdBetween(to, until)] : []),
      ...stale.map((hour) => createdBetween(hour, new Date(hour.getTime() + HOUR_MS))),
    ]),
  ]);
  add(byDomain, stored);
  add(byDomain, counted);
  return byDomain;
}

/** One domain's counts, or empty. */
export async function readDomainOutcomes(organizationId: string, domainId: string, since: Date, until: Date, now: Date): Promise<OutcomeCounts> {
  return (await readOutcomes({ organizationId, domainIds: [domainId] }, since, until, now)).get(domainId) ?? EMPTY_COUNTS;
}
