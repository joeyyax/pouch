import { and, asc, desc, eq, gte, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, domains, messages, organizations, providers } from "@/lib/db/schema";
import type { DomainStatus, MessageStatus } from "@/lib/db/schema";
import type { ProviderRow } from "@/lib/providers";
import { ADAPTER_KEYS, capabilitiesOf, isConfiguredFor } from "@/lib/providers/adapters";
import type { DomainCaller } from "@/lib/domains";
import { markMerges } from "@/lib/domains/spf";
import { domainDeleteBlock } from "@/lib/domains/deletable";
import { domainSetup } from "@/lib/domains/setup";
import { listKeys, type SerializedKey } from "@/lib/keys";
import { TERMINAL_STATUSES } from "@/lib/messages/lifecycle";
import { listSuppressionPage, requireUnscopedKey } from "@/lib/messages/suppression";
import { dbNow } from "@/lib/db/clock";
import { readDomainStanding as readStanding, readOrganizationReputation } from "@/lib/reputation/read";
import { standingReason } from "@/lib/reputation/standing";
import { selectShape } from "@/lib/api/shape";
import { statsShape } from "@/lib/schemas/stats";
import { readStats, type StatsResponse } from "@/lib/stats";
import { foldTotals } from "@/lib/dashboard/local-buckets";
import { daysIn, metricsRange, type MetricsRange } from "@/lib/metrics/window";
import { RATE_WINDOW_DAYS, domainStallView, adapterLabel, recordKey } from "@/lib/dashboard/views/domains";
import type {
  DomainDetailData,
  DomainKeys,
  DomainListItem,
  DomainPendingBinding,
  DomainStandingSummary,
  DomainSuppressionSummary,
  ProviderOption,
} from "@/lib/dashboard/views/domains";


/** Every domain name in the organization, for the scope select. */
export async function listDomainNames(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ name: domains.name })
    .from(domains)
    .where(eq(domains.organizationId, organizationId))
    .orderBy(asc(domains.name));
  return rows.map((row) => row.name);
}

const DOMAIN_LIST_SELECTION = selectShape(statsShape, { fields: ["domains", "buckets"] });

/**
 * Messages created in the window per domain, from `GET /v1/stats`: counts by status, and delivered
 * per day in `zone`, oldest first.
 */
async function domainActivity(organizationId: string, range: MetricsRange, zone: string, now: Date) {
  const caller = { organizationId, domainIds: [] };
  const window = { since: range.since, until: range.until, bucket: "hour" as const };
  const [all, delivered] = (await Promise.all([
    readStats(caller, window, DOMAIN_LIST_SELECTION, now),
    readStats(caller, { ...window, status: ["delivered"] }, DOMAIN_LIST_SELECTION, now),
  ])) as Pick<StatsResponse, "domains" | "buckets">[];
  const counts = new Map(all!.domains.map((row) => [row.domain_id, row.counts]));
  const keys = daysIn(range, zone).map((date) => date.toISOString().slice(0, 10));
  const starts = delivered!.buckets.map((bucket) => bucket.start);
  const daily = new Map(delivered!.domains.map((row) => [row.domain_id, foldTotals(starts, row.buckets, zone, "day")]));
  return {
    counts: (domainId: string) => counts.get(domainId),
    daily: (domainId: string) => keys.map((key) => daily.get(domainId)?.get(key) ?? 0),
  };
}

/** Keys scoped to each domain, and how many keys are scoped to nothing and so reach them all. */
async function keyScopes(organizationId: string): Promise<{ perDomain: Map<string, number>; unscoped: number }> {
  const rows = await db
    .select({ domainIds: apiKeys.domainIds })
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, organizationId), sql`${apiKeys.revokedAt} is null`));

  const perDomain = new Map<string, number>();
  let unscoped = 0;
  for (const row of rows) {
    if (row.domainIds.length === 0) {
      unscoped += 1;
      continue;
    }
    for (const id of row.domainIds) perDomain.set(id, (perDomain.get(id) ?? 0) + 1);
  }
  return { perDomain, unscoped };
}

/** `at` is for tests that pin the window; a real read takes the database's clock, which stamped `created_at`. */
export async function listDomains(organizationId: string, zone: string, at?: Date): Promise<DomainListItem[]> {
  const now = at ?? (await dbNow());
  const range = metricsRange(RATE_WINDOW_DAYS, now);
  const [rows, activity, scopes, reputation] = await Promise.all([
    db
      .select({ domain: domains, providerName: providers.name })
      .from(domains)
      .innerJoin(providers, eq(providers.id, domains.providerId))
      .where(eq(domains.organizationId, organizationId))
      .orderBy(asc(domains.name)),
    domainActivity(organizationId, range, zone, now),
    keyScopes(organizationId),
    readOrganizationReputation(organizationId, now),
  ]);

  // Verified first, then pending, then failed; alphabetical within.
  const order: Record<DomainStatus, number> = { verified: 0, pending: 1, failed: 2 };

  return rows
    .map(({ domain, providerName }) => {
      const counted = activity.counts(domain.id) ?? { delivered: 0, bounced: 0, complained: 0, failed: 0 };
      return {
        id: domain.id,
        name: domain.name,
        status: domain.status,
        createdAt: domain.createdAt,
        providerName,
        delivered: counted.delivered,
        deliveredDaily: activity.daily(domain.id),
        bounced: counted.bounced,
        complained: counted.complained,
        failed: counted.failed,
        keyCount: (scopes.perDomain.get(domain.id) ?? 0) + scopes.unscoped,
        moving: domain.pendingProviderId !== null,
        stall: domainStallView(domain),
        standing: reputation.domains.get(domain.id)?.standing ?? "healthy",
        standingReason: standingReason(reputation.domains.get(domain.id) ?? { standing: "healthy", findings: [] }),
      };
    })
    .sort((a, b) =>
      order[a.status] === order[b.status] ? a.name.localeCompare(b.name) : order[a.status] - order[b.status],
    );
}

/* ---------------------------------------------------------------- detail --- */

/**
 * Whether the adapter's own event plumbing is finished for this provider. Read from settings, so
 * drawing this screen never decrypts the provider's credentials.
 */
function eventsConfiguredFor(provider: ProviderRow): boolean {
  return isConfiguredFor(provider.adapter, provider.settings);
}

/** The domain screen's frame: what every section needs. Each section reads its own rows. */
export async function readDomain(caller: DomainCaller, id: string): Promise<DomainDetailData | null> {
  const { organizationId } = caller;
  const [row] = await db
    .select({ domain: domains, provider: providers })
    .from(domains)
    .innerJoin(providers, eq(providers.id, domains.providerId))
    .where(and(eq(domains.organizationId, organizationId), eq(domains.id, id)))
    .limit(1);

  if (!row) return null;
  const { domain, provider } = row;

  const pendingProvider = domain.pendingProviderId
    ? (
        await db
          .select({ id: providers.id, name: providers.name, adapter: providers.adapter })
          .from(providers)
          .where(and(eq(providers.organizationId, organizationId), eq(providers.id, domain.pendingProviderId)))
          .limit(1)
      )[0]
    : undefined;

  const pending: DomainPendingBinding | null = pendingProvider
    ? {
        providerId: pendingProvider.id,
        providerName: pendingProvider.name,
        adapterLabel: adapterLabel(pendingProvider.adapter),
        dnsRecords: markMerges(domain.pendingDnsRecords, domain.name),
        missingRecords: domain.pendingMissingRecords.map(recordKey),
        startedAt: domain.pendingStartedAt ?? domain.updatedAt,
      }
    : null;

  const deleteBlock = await domainDeleteBlock(domain);
  // Only the delete dialog reads this, and it opens only on a domain that can go.
  const liveScopedKeys = deleteBlock ? null : (await readDomainKeys(caller, domain.id)).keys.filter((key) => !key.revoked);

  const known = ADAPTER_KEYS.includes(provider.adapter);

  return {
    id: domain.id,
    name: domain.name,
    status: domain.status,
    dnsRecords: markMerges(domain.dnsRecords, domain.name),
    missingRecords: domain.missingRecords.map(recordKey),
    verificationErrors: domain.verificationErrors,
    verifiedAt: domain.verifiedAt,
    lastCheckedAt: domain.lastCheckedAt,
    createdAt: domain.createdAt,
    layout: domain.layout,
    provider: {
      id: provider.id,
      name: provider.name,
      adapter: provider.adapter,
      adapterLabel: adapterLabel(provider.adapter),
    },
    setup: domainSetup(provider.adapter, provider.id, eventsConfiguredFor(provider)),
    liveScopedKeys,
    deleteBlock,
    verifiable: known,
    pending,
    stall: domainStallView(domain),
    bulkAllowed: domain.bulkAllowed,
    bulkCapable: known && capabilitiesOf(provider.adapter).bulk,
  };
}

/** The Sending section's keys, from the same read as `GET /v1/keys?domain=`. */
export async function readDomainKeys(caller: DomainCaller, domainId: string): Promise<DomainKeys> {
  const reaching: SerializedKey[] = [];
  let cursor: string | undefined;
  do {
    const page = await listKeys(caller, 200, cursor, { domain: domainId });
    reaching.push(...page.data);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);

  return {
    keys: reaching
      .filter((key) => key.domain_ids.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((key) => ({ id: key.id, name: key.name, mode: key.mode, revoked: key.revoked_at !== null })),
    unscopedKeys: reaching.filter((key) => key.domain_ids.length === 0 && key.revoked_at === null).length,
  };
}

/** The latest few suppressions a message from here caused, from the same read as `GET /v1/suppressions?domain=`. */
export async function readDomainSuppressions(caller: DomainCaller, domainId: string): Promise<DomainSuppressionSummary[]> {
  requireUnscopedKey(caller);
  const page = await listSuppressionPage(caller.organizationId, { limit: RECENT_SUPPRESSIONS, domain: domainId });
  return page.data.map((row) => ({ id: row.id, address: row.address, reason: row.reason, createdAt: row.createdAt }));
}

const RECENT_SUPPRESSIONS = 10;

/** The providers a domain here can bind to, with the organization's assigned one marked. */
export async function listProviderOptions(organizationId: string): Promise<ProviderOption[]> {
  const [rows, [organization]] = await Promise.all([
    db
      .select({ id: providers.id, name: providers.name, adapter: providers.adapter })
      .from(providers)
      .where(and(eq(providers.organizationId, organizationId), eq(providers.shared, false)))
      .orderBy(asc(providers.name)),
    db
      .select({ providerId: organizations.providerId })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1),
  ]);

  return rows.map((row) => ({
    ...row,
    adapterLabel: adapterLabel(row.adapter),
    canAddDomains: ADAPTER_KEYS.includes(row.adapter) && capabilitiesOf(row.adapter).domainsViaApi,
    assigned: row.id === organization?.providerId,
  }));
}

/** The domain a first send would go from, for the empty state's example. */
export async function firstVerifiedDomain(organizationId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: domains.name })
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), eq(domains.status, "verified")))
    .orderBy(asc(domains.createdAt))
    .limit(1);
  return row?.name ?? null;
}

export interface InProgressTestMessage {
  id: string;
  status: MessageStatus;
  /** The single recipient the dashboard test-send card used. */
  to: string;
}

/** A test send can't realistically still be in progress from longer ago than this. */
const TEST_MESSAGE_WINDOW_MS = 60 * 60 * 1000;

/**
 * The domain's most recent dashboard test send that hasn't reached a terminal status yet, so
 * the test-email card can resume tracking it after a reload instead of showing a fresh form.
 * Bounded to the last hour and to one row — this is a single-operator dashboard, not per-session
 * tracking.
 */
export async function latestInProgressTestMessage(
  organizationId: string,
  domainId: string,
): Promise<InProgressTestMessage | null> {
  const since = new Date(Date.now() - TEST_MESSAGE_WINDOW_MS);
  const [row] = await db
    .select({ id: messages.id, status: messages.status, recipients: messages.recipients })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.domainId, domainId),
        sql`${messages.tags} @> ARRAY['dashboard-test']::text[]`,
        notInArray(messages.status, [...TERMINAL_STATUSES]),
        gte(messages.createdAt, since),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);

  if (!row) return null;
  return { id: row.id, status: row.status, to: row.recipients[0] ?? "" };
}

/** The domain page's reputation line. */
export async function readDomainStanding(organizationId: string, domainId: string): Promise<DomainStandingSummary | null> {
  const reputation = await readStanding(organizationId, domainId, await dbNow());
  if (!reputation) return null;
  return { standing: reputation.standing, lead: reputation.findings[0] ?? null };
}
