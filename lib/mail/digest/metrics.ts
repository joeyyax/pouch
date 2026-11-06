/**
 * What one digest reports: the operator's view of the window across every organization. Volume
 * and outcomes, how they split by provider and organization, what needs a look, and what changed.
 *
 * Everything here is a record of the window, never live state. Queue depth and loop health stay on
 * the admin system screen and ntfy: a digest stuck in the queue it reports on can't report it
 * (`docs/decisions.md`, "Digests are the service admin's").
 */
import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  activity,
  domains,
  inboundMessages,
  messageEvents,
  messageHourlyStats,
  messages,
  organizations,
  providerFindings,
  providers,
  reputationStates,
  webhookDeliveries,
  webhookEndpoints,
} from "@/lib/db/schema";
import type { DeliveryShift } from "@/lib/metrics/delivery-time";
import type { ConditionTone } from "@/lib/metrics/conditions";
import type { OutcomeCounts } from "@/lib/metrics/rates";
import { BASELINE_DAYS } from "@/lib/metrics/volume";
import { runObservations } from "@/lib/observations/_runner";
import { readDeliveryShifts } from "@/lib/stats/delivery-time";
import type { Standing } from "@/lib/reputation/standing";
import type { StallLines } from "@/lib/domains/guard";
import { readStallLines } from "@/lib/domains/stall";
import type { DigestWindow } from "./cadence";

export interface DigestBounceReason {
  reason: string;
  count: number;
}

export type DigestOutcomes = Pick<OutcomeCounts, "delivered" | "bounced" | "complained" | "failed">;

export interface DigestBucket {
  start: Date;
  total: number;
}

export interface DigestBreakdownRow extends DigestOutcomes {
  id: string;
  name: string;
  total: number;
}

export interface DigestOrganizationRef {
  organizationId: string;
  organization: string;
}

export interface DigestStandingChange extends DigestOrganizationRef {
  subject: string;
  /** Null when the organization itself moved. */
  domainId: string | null;
  standing: Standing;
}

export interface DigestFinding extends DigestOrganizationRef {
  type: string;
  providerId: string;
  provider: string;
}

export interface DigestStalledDomain extends DigestOrganizationRef {
  domainId: string;
  domain: string;
}

export interface DigestSlowDomain extends DigestOrganizationRef, DeliveryShift {
  domainId: string;
  domain: string;
}

/** One observation finding in one organization, worded for the digest. */
export interface DigestObservation extends DigestOrganizationRef {
  key: string;
  tone: ConditionTone;
  text: string;
  /** A dashboard path inside the organization. */
  path: string;
}

export interface DigestOrganizationCount extends DigestOrganizationRef {
  count: number;
}

export interface DigestAttention {
  standingChanges: DigestStandingChange[];
  findings: DigestFinding[];
  stalledDomains: DigestStalledDomain[];
  slowDomains: DigestSlowDomain[];
  observations: DigestObservation[];
  suspended: DigestOrganizationRef[];
  webhooksExhausted: DigestOrganizationCount[];
  endpointsDisabled: DigestOrganizationCount[];
  failedSignIns: DigestOrganizationCount[];
}

export interface DigestInbound {
  received: number;
  spam: number;
  dmarcFailed: number;
  virus: number;
}

export interface DigestGrowth {
  organizations: number;
  domainsVerified: number;
  keys: number;
  suppressions: number;
}

export interface DigestSummary extends DigestOutcomes {
  window: DigestWindow;
  total: number;
  previousTotal: number;
  previous: DigestOutcomes;
  buckets: DigestBucket[];
  providers: DigestBreakdownRow[];
  organizations: DigestBreakdownRow[];
  topBounceReasons: DigestBounceReason[];
  attention: DigestAttention;
  inbound: DigestInbound;
  growth: DigestGrowth;
  /** The stall lines the tones read. */
  lines: StallLines;
}

const BREAKDOWN_LIMIT = 5;
const LIST_LIMIT = 5;

/** Every organization's messages, test-mode sends aside. */
function tenantWindow(since: Date, until: Date) {
  return and(eq(messages.testMode, false), gte(messages.createdAt, since), lt(messages.createdAt, until));
}

const outcomeColumns = {
  total: sql<number>`count(*)::int`,
  delivered: sql<number>`count(*) filter (where ${messages.status} = 'delivered')::int`,
  bounced: sql<number>`count(*) filter (where ${messages.status} = 'bounced')::int`,
  complained: sql<number>`count(*) filter (where ${messages.status} = 'complained')::int`,
  failed: sql<number>`count(*) filter (where ${messages.status} = 'failed')::int`,
};

async function countOutcomes(since: Date, until: Date) {
  const [row] = await db.select(outcomeColumns).from(messages).where(tenantWindow(since, until));
  return row ?? { total: 0, delivered: 0, bounced: 0, complained: 0, failed: 0 };
}

/** Hourly for a daily digest, daily otherwise. Empty buckets included, so the chart has no gaps. */
async function readBuckets(window: DigestWindow): Promise<DigestBucket[]> {
  const unit = window.cadence === "daily" ? "hour" : "day";
  const rows = await db.execute<{ start: string; total: number }>(sql`
    select bucket as start, coalesce(counted.total, 0)::int as total
    from generate_series(${window.since.toISOString()}::timestamptz, ${window.until.toISOString()}::timestamptz - interval '1 ${sql.raw(unit)}', interval '1 ${sql.raw(unit)}') as bucket
    left join (
      select date_trunc(${unit}, ${messages.createdAt}, 'UTC') as start, count(*) as total
      from ${messages}
      where ${tenantWindow(window.since, window.until)}
      group by 1
    ) counted on counted.start = bucket
    order by bucket
  `);
  return rows.map((row) => ({ start: new Date(row.start), total: Number(row.total) }));
}

async function byProvider(since: Date, until: Date): Promise<DigestBreakdownRow[]> {
  return db
    .select({ id: providers.id, name: providers.name, ...outcomeColumns })
    .from(messages)
    .innerJoin(providers, eq(providers.id, messages.providerId))
    .where(tenantWindow(since, until))
    .groupBy(providers.id, providers.name)
    .orderBy(desc(sql`count(*)`))
    .limit(BREAKDOWN_LIMIT);
}

async function byOrganization(since: Date, until: Date): Promise<DigestBreakdownRow[]> {
  return db
    .select({ id: organizations.id, name: organizations.name, ...outcomeColumns })
    .from(messages)
    .innerJoin(organizations, eq(organizations.id, messages.organizationId))
    .where(tenantWindow(since, until))
    .groupBy(organizations.id, organizations.name)
    .orderBy(desc(sql`count(*)`))
    .limit(BREAKDOWN_LIMIT);
}

/** The provider's own words, verbatim, most common first. Same shape as the domain overview's. */
async function topBounceReasons(since: Date, until: Date): Promise<DigestBounceReason[]> {
  const rows = await db
    .select({ reason: messageEvents.reason, count: sql<number>`count(*)::int` })
    .from(messageEvents)
    .where(
      and(
        sql`${messageEvents.status} in ('bounced', 'complained')`,
        isNotNull(messageEvents.reason),
        gte(messageEvents.occurredAt, since),
        lt(messageEvents.occurredAt, until),
      ),
    )
    .groupBy(messageEvents.reason)
    .orderBy(sql`count(*) desc`)
    .limit(3);
  return rows.filter((row): row is DigestBounceReason => row.reason !== null);
}

/** Domains and organizations that moved into watch or worse during the window and are still there. */
async function standingChanges(since: Date, until: Date): Promise<DigestStandingChange[]> {
  const rows = await db
    .select({
      subjectType: reputationStates.subjectType,
      subjectId: reputationStates.subjectId,
      domain: domains.name,
      organizationId: organizations.id,
      organization: organizations.name,
      standing: reputationStates.standing,
    })
    .from(reputationStates)
    .innerJoin(organizations, eq(organizations.id, reputationStates.organizationId))
    .leftJoin(domains, and(eq(reputationStates.subjectType, "domain"), eq(domains.id, reputationStates.subjectId)))
    .where(
      and(
        inArray(reputationStates.standing, ["watch", "at_risk", "paused"]),
        gte(reputationStates.changedAt, since),
        lt(reputationStates.changedAt, until),
      ),
    )
    .orderBy(desc(reputationStates.changedAt))
    .limit(LIST_LIMIT);
  return rows.map((row) => ({
    subject: row.subjectType === "domain" ? (row.domain ?? "A deleted domain") : row.organization,
    domainId: row.subjectType === "domain" && row.domain ? row.subjectId : null,
    organizationId: row.organizationId,
    organization: row.organization,
    standing: row.standing,
  }));
}

async function findingsOpened(since: Date, until: Date): Promise<DigestFinding[]> {
  return db
    .select({
      type: providerFindings.type,
      providerId: providers.id,
      provider: providers.name,
      organizationId: organizations.id,
      organization: organizations.name,
    })
    .from(providerFindings)
    .innerJoin(providers, eq(providers.id, providerFindings.providerId))
    .innerJoin(organizations, eq(organizations.id, providerFindings.organizationId))
    .where(and(gte(providerFindings.openedAt, since), lt(providerFindings.openedAt, until)))
    .orderBy(desc(providerFindings.openedAt))
    .limit(LIST_LIMIT);
}

/** Domains that stalled in the window and are still stalled. */
async function stalledDomains(since: Date, until: Date): Promise<DigestStalledDomain[]> {
  return db
    .select({ domainId: domains.id, domain: domains.name, organizationId: organizations.id, organization: organizations.name })
    .from(domains)
    .innerJoin(organizations, eq(organizations.id, domains.organizationId))
    .where(and(gte(domains.stalledAt, since), lt(domains.stalledAt, until)))
    .orderBy(desc(domains.stalledAt))
    .limit(LIST_LIMIT);
}

/** Domains whose delivery time ended the window well above their own normal, slowest against normal first. */
async function slowDomains(until: Date): Promise<DigestSlowDomain[]> {
  const shifts = await readDeliveryShifts({}, new Date(until.getTime() - 1));
  if (shifts.size === 0) return [];
  const rows = await db
    .select({ domainId: domains.id, domain: domains.name, organizationId: organizations.id, organization: organizations.name })
    .from(domains)
    .innerJoin(organizations, eq(organizations.id, domains.organizationId))
    .where(inArray(domains.id, [...shifts.keys()]));
  return rows
    .map((row) => ({ ...row, ...shifts.get(row.domainId)! }))
    .sort((a, b) => b.p90Ms / b.baselineMs - a.p90Ms / a.baselineMs)
    .slice(0, LIST_LIMIT);
}

/**
 * Every observation, as of the window's end, in each organization that sent live mail in the
 * baseline span or sensitive mail in the last day. Organizations run one at a time.
 */
async function observations(until: Date): Promise<DigestObservation[]> {
  const now = new Date(until.getTime() - 1);
  const since = new Date(until.getTime() - (BASELINE_DAYS + 1) * 24 * 60 * 60 * 1000);
  const dayAgo = new Date(until.getTime() - 24 * 60 * 60 * 1000);
  const ids = await db
    .selectDistinct({ id: messageHourlyStats.organizationId })
    .from(messageHourlyStats)
    .where(and(eq(messageHourlyStats.testMode, false), gte(messageHourlyStats.hour, since), lt(messageHourlyStats.hour, until)))
    .union(
      db
        .selectDistinct({ id: messages.organizationId })
        .from(messages)
        .where(and(isNotNull(messages.bodyWithheld), eq(messages.testMode, false), gte(messages.createdAt, dayAgo), lt(messages.createdAt, until))),
    );
  if (ids.length === 0) return [];

  const names = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(inArray(organizations.id, ids.flatMap((row) => (row.id === null ? [] : [row.id]))))
    .orderBy(organizations.name);
  const out: DigestObservation[] = [];
  for (const organization of names) {
    for (const result of await runObservations(organization.id, now)) {
      out.push({ organizationId: organization.id, organization: organization.name, key: result.key, tone: result.tone, ...result.digest });
    }
  }
  return out;
}

async function suspendedOrganizations(since: Date, until: Date): Promise<DigestOrganizationRef[]> {
  return db
    .select({ organizationId: organizations.id, organization: organizations.name })
    .from(organizations)
    .where(and(gte(organizations.suspendedAt, since), lt(organizations.suspendedAt, until)))
    .orderBy(desc(organizations.suspendedAt))
    .limit(LIST_LIMIT);
}

const perOrganization = {
  organizationId: organizations.id,
  organization: organizations.name,
  count: sql<number>`count(*)::int`,
};

async function exhaustedDeliveries(since: Date, until: Date): Promise<DigestOrganizationCount[]> {
  return db
    .select(perOrganization)
    .from(webhookDeliveries)
    .innerJoin(organizations, eq(organizations.id, webhookDeliveries.organizationId))
    .where(and(eq(webhookDeliveries.status, "exhausted"), gte(webhookDeliveries.createdAt, since), lt(webhookDeliveries.createdAt, until)))
    .groupBy(organizations.id, organizations.name)
    .orderBy(desc(sql`count(*)`))
    .limit(LIST_LIMIT);
}

async function disabledEndpoints(since: Date, until: Date): Promise<DigestOrganizationCount[]> {
  return db
    .select(perOrganization)
    .from(webhookEndpoints)
    .innerJoin(organizations, eq(organizations.id, webhookEndpoints.organizationId))
    .where(and(gte(webhookEndpoints.disabledAt, since), lt(webhookEndpoints.disabledAt, until)))
    .groupBy(organizations.id, organizations.name)
    .orderBy(desc(sql`count(*)`))
    .limit(LIST_LIMIT);
}

async function failedSignIns(since: Date, until: Date): Promise<DigestOrganizationCount[]> {
  return db
    .select(perOrganization)
    .from(activity)
    .innerJoin(organizations, eq(organizations.id, activity.organizationId))
    .where(and(eq(activity.action, "session.sign_in.failed"), gte(activity.createdAt, since), lt(activity.createdAt, until)))
    .groupBy(organizations.id, organizations.name)
    .orderBy(desc(sql`count(*)`))
    .limit(LIST_LIMIT);
}

/** Activity rows per action in the window, across every organization. */
async function growthCounts(since: Date, until: Date): Promise<Map<string, number>> {
  const rows = await db
    .select({ action: activity.action, count: sql<number>`count(*)::int` })
    .from(activity)
    .where(
      and(
        inArray(activity.action, ["organization.created", "domain.verified", "key.created", "suppression.added"]),
        gte(activity.createdAt, since),
        lt(activity.createdAt, until),
      ),
    )
    .groupBy(activity.action);
  return new Map(rows.map((row) => [row.action, row.count]));
}

async function readInbound(since: Date, until: Date): Promise<DigestInbound> {
  const [row] = await db
    .select({
      received: sql<number>`count(*)::int`,
      spam: sql<number>`count(*) filter (where ${inboundMessages.verdicts}->>'spam' = 'fail')::int`,
      dmarcFailed: sql<number>`count(*) filter (where ${inboundMessages.verdicts}->>'dmarc' = 'fail')::int`,
      virus: sql<number>`count(*) filter (where ${inboundMessages.verdicts}->>'virus' = 'fail')::int`,
    })
    .from(inboundMessages)
    .where(and(gte(inboundMessages.receivedAt, since), lt(inboundMessages.receivedAt, until)));
  return row ?? { received: 0, spam: 0, dmarcFailed: 0, virus: 0 };
}

/** `null` when the window had nothing sent — the caller's signal not to build a digest at all. */
export async function readDigestSummary(window: DigestWindow): Promise<DigestSummary | null> {
  const { since, until } = window;
  const current = await countOutcomes(since, until);
  if (current.total === 0) return null;

  const [previous, buckets, providerRows, organizationRows, reasons, changes, findings, stalled, slow, observed, suspended, exhausted, disabled, signIns, actions, inbound, lines] =
    await Promise.all([
      countOutcomes(window.previousSince, window.previousUntil),
      readBuckets(window),
      byProvider(since, until),
      byOrganization(since, until),
      topBounceReasons(since, until),
      standingChanges(since, until),
      findingsOpened(since, until),
      stalledDomains(since, until),
      slowDomains(until),
      observations(until),
      suspendedOrganizations(since, until),
      exhaustedDeliveries(since, until),
      disabledEndpoints(since, until),
      failedSignIns(since, until),
      growthCounts(since, until),
      readInbound(since, until),
      readStallLines(),
    ]);

  const action = (name: string) => actions.get(name) ?? 0;
  const { total, ...outcomes } = current;
  const { total: previousTotal, ...previousOutcomes } = previous;

  return {
    window,
    total,
    ...outcomes,
    previousTotal,
    previous: previousOutcomes,
    buckets,
    providers: providerRows,
    organizations: organizationRows,
    topBounceReasons: reasons,
    attention: {
      standingChanges: changes,
      findings,
      stalledDomains: stalled,
      slowDomains: slow,
      observations: observed,
      suspended,
      webhooksExhausted: exhausted,
      endpointsDisabled: disabled,
      failedSignIns: signIns,
    },
    inbound,
    growth: {
      organizations: action("organization.created"),
      domainsVerified: action("domain.verified"),
      keys: action("key.created"),
      suppressions: action("suppression.added"),
    },
    lines,
  };
}
