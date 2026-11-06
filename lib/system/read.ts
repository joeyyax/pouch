/**
 * The operator's mechanism-level view: which loop last claimed something, which rows are stuck
 * locked, and which organization is generating queue depth. #71's org-scoped view can't show
 * any of this without leaking how the service is built — see docs/decisions.md and #73.
 */
import { readSetting } from "@/lib/settings/values";
import { bodyLifecycleStatus, inboundLifecycleStatus, readBodyLifecycle, readInboundLifecycle } from "@/lib/storage/lifecycle";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { readQuotas, readRates, type QuotaReading, type RatesReading } from "@/lib/providers/provider-metrics";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { messageEvents, messages, organizations, providers } from "@/lib/db/schema";
import { LOCK_TIMEOUT_MS } from "@/lib/messages/queue";
import { readJobs, type LoopName } from "@/lib/health";
import { ABANDON_MS } from "@/lib/metrics/conditions";
import { webhookUrl } from "@/lib/webhooks/url";
import { RATE_WINDOW_DAYS } from "@/lib/metrics/window";
import { SERVICE_MAIL_LABEL, UNCONFIRMED_WINDOW_MS, unconfirmedClustered } from "./views";
import type {
  LoopLivenessView,
  OrganizationQueueView,
  ProviderIdentityGroupView,
  StuckLockView,
  UnconfirmedClusterView,
  UnconfirmedProviderView,
} from "./views";

const LOOP_LABEL: Record<LoopName, string> = {
  send: "Send",
  verify: "Verify",
  retention: "Retention",
  "test-mode": "Test mode",
  webhook: "Webhook",
  digest: "Digest",
  "inbound-retention": "Inbound retention",
  "address-expiry": "Address expiry",
  forward: "Forwards",
  list: "List confirmations",
  abandon: "Unconfirmed marking",
  export: "Exports",
  "stall-guard": "Reputation guard",
  "provider-health": "Provider health",
  blocklists: "Blocklists",
  "domain-stats": "Domain stats",
  "activity-retention": "Activity retention",
  "health-watch": "Health watch",
};

export type { LoopName } from "@/lib/health";

/**
 * Every loop the worker runs, whether or not it has ever recorded a run: a loop with no row is
 * exactly the one an operator needs to see, not one that quietly vanishes.
 */
export async function readLoopLiveness(): Promise<LoopLivenessView[]> {
  return (await readJobs()).map(({ name, state, row }) => ({
    loop: name,
    label: LOOP_LABEL[name],
    status: state,
    lastRunAt: row?.lastFinishedAt ?? row?.lastStartedAt ?? null,
    intervalMs: row?.intervalMs ?? null,
    consecutiveFailures: row?.consecutiveFailures ?? 0,
  }));
}

/**
 * Queued rows locked longer than the lease allows — the worker that claimed them died before
 * releasing them, and nothing but this list makes that visible. Oldest first: the row that's
 * been stuck longest is the one worth looking at first.
 */
export async function listStuckLocks(): Promise<StuckLockView[]> {
  const now = await dbNow();
  const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);

  const rows = await db
    .select({
      messageId: messages.id,
      organizationId: messages.organizationId,
      organizationName: organizations.name,
      lockedAt: messages.lockedAt,
      lockedBy: messages.lockedBy,
    })
    .from(messages)
    .leftJoin(organizations, eq(organizations.id, messages.organizationId))
    .where(and(eq(messages.status, "queued"), isNotNull(messages.lockedAt), isNotNull(messages.lockedBy), lt(messages.lockedAt, staleBefore)))
    .orderBy(asc(messages.lockedAt));

  return rows.map((row) => ({
    messageId: row.messageId,
    organizationId: row.organizationId,
    organizationName: row.organizationName ?? SERVICE_MAIL_LABEL,
    lockedAt: row.lockedAt as Date,
    lockedBy: row.lockedBy as string,
  }));
}

/**
 * Queue depth and the oldest queued row, per organization. A single caller in a retry storm
 * shows up here as one organization's depth running away from every other's.
 */
export async function listQueueByOrganization(): Promise<OrganizationQueueView[]> {
  const rows = await db
    .select({
      organizationId: messages.organizationId,
      organizationName: organizations.name,
      depth: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${messages.createdAt})`,
    })
    .from(messages)
    .leftJoin(organizations, eq(organizations.id, messages.organizationId))
    .where(eq(messages.status, "queued"))
    .groupBy(messages.organizationId, organizations.name)
    .orderBy(desc(sql`count(*)`));

  return rows.map((row) => ({
    organizationId: row.organizationId,
    organizationName: row.organizationName ?? SERVICE_MAIL_LABEL,
    depth: row.depth,
    oldestQueuedAt: row.oldest ? new Date(row.oldest) : null,
  }));
}

/**
 * Unconfirmed marks in the last window, against the sends they were drawn from.
 *
 * One message with no delivery confirmation is a provider gap nobody can act on. A cluster is
 * ours: a deploy, a webhook answering 500, a dead SNS subscription. Since #403 the SNS retry
 * window is about 52 minutes, so anything that clusters here outlasted that or the subscription
 * is broken.
 *
 * The denominator is shifted, not the same 24 hours as the marks: a message marked now was sent
 * ABANDON_MS ago, so the sends up for marking in this window are the ones that landed between
 * two and one window-widths back. Comparing marks against sends made in the same hours would
 * measure a rate against mail too young to be marked at all.
 */
export async function readUnconfirmedCluster(): Promise<UnconfirmedClusterView> {
  const now = await dbNow();
  const markedSince = new Date(now.getTime() - UNCONFIRMED_WINDOW_MS);
  const sentUntil = new Date(now.getTime() - ABANDON_MS);
  const sentSince = new Date(sentUntil.getTime() - UNCONFIRMED_WINDOW_MS);

  const [marks, [sends]] = await Promise.all([
    db
      .select({ providerId: messages.providerId, marked: sql<number>`count(*)::int` })
      .from(messages)
      .where(gte(messages.abandonedAt, markedSince))
      .groupBy(messages.providerId)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(gte(messages.sentAt, sentSince), lt(messages.sentAt, sentUntil))),
  ]);

  const marked = marks.reduce((sum, row) => sum + row.marked, 0);
  const eligibleSends = sends?.total ?? 0;

  const providerIds = marks.map((row) => row.providerId).filter((id): id is string => id !== null);
  const rows = providerIds.length
    ? await db
        .select({
          id: providers.id,
          adapter: providers.adapter,
          name: providers.name,
          organizationName: organizations.name,
        })
        .from(providers)
        .innerJoin(organizations, eq(organizations.id, providers.organizationId))
        .where(inArray(providers.id, providerIds))
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));

  const providerViews: UnconfirmedProviderView[] = marks.map((mark) => {
    const provider = mark.providerId ? byId.get(mark.providerId) : undefined;
    return {
      providerId: mark.providerId,
      providerName: provider?.name ?? null,
      adapter: provider?.adapter ?? null,
      organizationName: provider?.organizationName ?? null,
      marked: mark.marked,
      webhookUrl: provider ? webhookUrl(provider.adapter, provider.id) : null,
    };
  });

  return {
    marked,
    eligibleSends,
    share: eligibleSends > 0 ? marked / eligibleSends : null,
    clustered: unconfirmedClustered(marked, eligibleSends),
    providers: providerViews,
  };
}

/**
 * Delivery, bounce and complaint counts across every organization, grouped by the underlying
 * provider identity rather than by Pouch's own provider row or organization — two
 * organizations sitting at 3% bounce each on the same suspended AWS account is exactly what an
 * organization-scoped view can't show.
 *
 * A provider with no known identity groups alone: never merged with another unidentified
 * provider, since two unknowns are not known to be the same provider. See docs/decisions.md,
 * "A provider's identity comes from the provider, never a guess."
 */
export async function listProviderIdentityRates(): Promise<ProviderIdentityGroupView[]> {
  const rows = await db
    .select({
      id: providers.id,
      adapter: providers.adapter,
      identity: providers.providerIdentity,
      organizationName: organizations.name,
    })
    .from(providers)
    .innerJoin(organizations, eq(organizations.id, providers.organizationId));

  if (rows.length === 0) return [];

  // Two providers group together only when both name the same provider and the same identity.
  // A provider with no identity gets a key nothing else can collide with.
  const groupKeyOf = (provider: { id: string; adapter: string; identity: string | null }) =>
    provider.identity ? `${provider.adapter}:${provider.identity}` : `unidentified:${provider.id}`;

  const groups = new Map<
    string,
    { adapter: string; identity: string | null; providerIds: string[]; organizationNames: Set<string> }
  >();
  for (const provider of rows) {
    const key = groupKeyOf(provider);
    const group = groups.get(key) ?? { adapter: provider.adapter, identity: provider.identity, providerIds: [], organizationNames: new Set() };
    group.providerIds.push(provider.id);
    group.organizationNames.add(provider.organizationName);
    groups.set(key, group);
  }

  const since = new Date(Date.now() - RATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const providerIds = rows.map((provider) => provider.id);
  const eventRows = await db
    .select({
      providerId: messageEvents.providerId,
      delivered: sql<number>`count(*) filter (where ${messageEvents.status} = 'delivered')::int`,
      bounced: sql<number>`count(*) filter (where ${messageEvents.status} = 'bounced')::int`,
      complained: sql<number>`count(*) filter (where ${messageEvents.status} = 'complained')::int`,
      failed: sql<number>`count(*) filter (where ${messageEvents.status} = 'failed')::int`,
    })
    .from(messageEvents)
    .where(and(inArray(messageEvents.providerId, providerIds), gte(messageEvents.occurredAt, since)))
    .groupBy(messageEvents.providerId);

  const countsByProviderId = new Map(eventRows.map((row) => [row.providerId as string, row]));

  const groupKeyByProviderId = new Map(rows.map((provider) => [provider.id, groupKeyOf(provider)]));
  const totalsByGroupKey = new Map<string, { delivered: number; bounced: number; complained: number; failed: number }>();
  for (const [providerId, key] of groupKeyByProviderId) {
    const counts = countsByProviderId.get(providerId);
    if (!counts) continue;
    const totals = totalsByGroupKey.get(key) ?? { delivered: 0, bounced: 0, complained: 0, failed: 0 };
    totals.delivered += counts.delivered;
    totals.bounced += counts.bounced;
    totals.complained += counts.complained;
    totals.failed += counts.failed;
    totalsByGroupKey.set(key, totals);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const totals = totalsByGroupKey.get(key) ?? { delivered: 0, bounced: 0, complained: 0, failed: 0 };
      return {
        key,
        adapter: group.adapter,
        identity: group.identity,
        providerIds: group.providerIds,
        organizationNames: [...group.organizationNames].sort(),
        ...totals,
      };
    })
    .sort((a, b) => b.bounced + b.complained - (a.bounced + a.complained));
}

export interface ProviderMetricsView {
  key: string;
  adapter: string;
  identity: string | null;
  providerNames: string[];
  organizationNames: string[];
  shared: boolean;
  quota: QuotaReading | null;
  rates: RatesReading | null;
}

/** What each provider reports about itself, one entry per underlying provider. An assignment reads through its shared provider. */
/** Organization names each shared provider serves through its tenant rows, sorted. */
async function tenantOrganizations(sharedIds: string[]): Promise<Map<string, string[]>> {
  if (sharedIds.length === 0) return new Map();
  const rows = await db
    .select({ sharedId: providers.sharedProviderId, name: organizations.name })
    .from(providers)
    .innerJoin(organizations, eq(organizations.id, providers.organizationId))
    .where(inArray(providers.sharedProviderId, sharedIds));
  const served = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.sharedId) continue;
    served.set(row.sharedId, [...new Set([...(served.get(row.sharedId) ?? []), row.name])].sort());
  }
  return served;
}

export async function listProviderMetrics(): Promise<ProviderMetricsView[]> {
  const rows = await db
    .select({
      id: providers.id,
      adapter: providers.adapter,
      name: providers.name,
      identity: providers.providerIdentity,
      shared: providers.shared,
      organizationName: organizations.name,
    })
    .from(providers)
    // A shared provider belongs to no organization; the organizations its tenants serve stand in.
    .leftJoin(organizations, eq(organizations.id, providers.organizationId))
    .where(isNull(providers.sharedProviderId))
    .orderBy(asc(providers.name));
  if (rows.length === 0) return [];

  const ids = rows.map((provider) => provider.id);
  const [quotas, rates, served] = await Promise.all([readQuotas(ids), readRates(ids), tenantOrganizations(rows.filter((row) => row.shared).map((row) => row.id))]);
  const groups = new Map<string, ProviderMetricsView>();
  for (const provider of rows) {
    const quota = quotas.get(provider.id) ?? null;
    const rate = rates.get(provider.id) ?? null;
    if (!quota && !rate) continue;
    const key = provider.identity ? `${provider.adapter}:${provider.identity}` : `unidentified:${provider.id}`;
    const group = groups.get(key) ?? {
      key,
      adapter: provider.adapter,
      identity: provider.identity,
      providerNames: [],
      organizationNames: [],
      shared: false,
      quota: null,
      rates: null,
    };
    group.providerNames.push(provider.name);
    for (const name of provider.organizationName ? [provider.organizationName] : (served.get(provider.id) ?? [])) {
      if (!group.organizationNames.includes(name)) group.organizationNames.push(name);
    }
    group.shared ||= provider.shared;
    if (!group.quota || (quota && quota.checkedAt > group.quota.checkedAt)) group.quota = quota ?? group.quota;
    if (!group.rates || (rate && rate.checkedAt > group.rates.checkedAt)) group.rates = rate ?? group.rates;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export interface BodyLifecycleView {
  /** The retention ceiling, in days. */
  ceiling: number;
  /** Days the bucket's rule expires bodies after, or null when there's none or it can't be read. */
  expiryDays: number | null;
  status: "ok" | "degraded" | "unknown";
}

/** The bucket's rule for bodies beside the retention ceiling, read through the same cache as the health check. */
export async function readBodyLifecycleView(): Promise<BodyLifecycleView> {
  const [lifecycle, ceiling] = await Promise.all([readBodyLifecycle(), readSetting("body_retention_max_days")]);
  return { ceiling, expiryDays: lifecycle.state === "rule" ? lifecycle.days : null, status: bodyLifecycleStatus(lifecycle, ceiling) };
}

/** The bucket's rule for inbound mail beside its retention ceiling. No rule is fine: the inbound sweep deletes the objects itself. */
export async function readInboundLifecycleView(): Promise<BodyLifecycleView> {
  const [lifecycle, ceiling] = await Promise.all([readInboundLifecycle(), readSetting("inbound_retention_max_days")]);
  return { ceiling, expiryDays: lifecycle.state === "rule" ? lifecycle.days : null, status: inboundLifecycleStatus(lifecycle, ceiling) };
}
