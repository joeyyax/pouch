/** Standing computed on read, for the dashboard and the worker's transition check. */
import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messageEvents, messages, organizations, providers } from "@/lib/db/schema";
import { readRates, readTenantVolume } from "@/lib/providers/provider-metrics";
import type { TenantVolume } from "@/lib/providers/adapters/types";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { domainStallView } from "@/lib/domains/guard";
import { STALL_WINDOW_DAYS, type StallLines } from "@/lib/domains/guard";
import { domainOutcomeWindow, readStallLines } from "@/lib/domains/stall";
import { EMPTY_COUNTS } from "@/lib/metrics/rates";
import { organizationOutcomesByDomain, organizationSums } from "@/lib/suspension/guard";
import { suspensionOf } from "@/lib/suspension";
import { bounceTypeLabel } from "./bounce-type";
import { openFindingsOnProvider, openProviderFindings, type OpenProviderFinding } from "./provider-findings";
import { readSignals } from "./signals";
import { readBlocklistListings, recentLinkListings, type LinkedListingRow } from "./blocklists";
import { domainChecks } from "@/lib/blocklists/domains";
import { readProviderAlignment } from "@/lib/dmarc/read";
import { blocklistStatus, type BlocklistStatus } from "@/lib/blocklists/status";
import type { DomainBlocklistCheckRow } from "@/lib/db/schema";
import {
  evaluateOrganizationStanding,
  coveredMetrics,
  evaluateStanding,
  readMetric,
  type ProviderRates,
  type BehaviorSignals,
  type BlocklistListing,
  type MetricReading,
  type OrganizationStandingResult,
  type StandingResult,
} from "./standing";

const DAY_MS = 24 * 60 * 60 * 1000;

const log = logger.child("reputation");

/** The longer window the domain panel shows beside the guard's own. */
export const LONG_WINDOW_DAYS = 30;

/** Recent reasons the domain panel lists. */
export const RECENT_REASON_LIMIT = 6;

export interface DomainStanding extends StandingResult {
  id: string;
  name: string;
}

export interface OrganizationReputation extends OrganizationStandingResult {
  name: string;
  /** The stall lines it was read against. */
  lines: StallLines;
  /** Every domain's standing, keyed by id. */
  domains: Map<string, DomainStanding>;
}

export interface ReputationWindow {
  days: number;
  bounce: MetricReading;
  complaint: MetricReading;
}

export interface RecentReason {
  status: "bounced" | "complained";
  reason: string;
  /** The provider's bounce subtype in plain words, when it has one. */
  kind: string | null;
  count: number;
  lastAt: Date;
}

export interface DomainReputation extends StandingResult {
  name: string;
  signals: BehaviorSignals | null;
  windows: ReputationWindow[];
  reasons: RecentReason[];
  /** Open findings SES reports on the organization's own space, when the domain sends through a shared provider. */
  providerFindings: OpenProviderFinding[];
  providerId: string;
  blocklists: DomainBlocklists;
  /** SES's own counts for the organization's tenant. Null off a tenant, or when SES can't be read. */
  tenantVolume: TenantVolume | null;
}

export interface DomainBlocklists {
  status: BlocklistStatus;
  checks: DomainBlocklistCheckRow[];
  links: LinkedListingRow[];
}

/** Every domain in the organization, and the organization itself. */
export async function readOrganizationReputation(organizationId: string, now: Date): Promise<OrganizationReputation> {
  const since = new Date(now.getTime() - STALL_WINDOW_DAYS * DAY_MS);
  const previousSince = new Date(since.getTime() - STALL_WINDOW_DAYS * DAY_MS);

  const [org, domainRows, current, previous, signals, suspension, findings, listings, lines, dmarc] = await Promise.all([
    db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId)).limit(1),
    db.select().from(domains).where(eq(domains.organizationId, organizationId)),
    organizationOutcomesByDomain(organizationId, since, now, now),
    organizationOutcomesByDomain(organizationId, previousSince, since, now),
    readSignals(organizationId, now),
    suspensionOf(organizationId),
    openProviderFindings(organizationId),
    readBlocklistListings(organizationId, now),
    readStallLines(),
    readProviderAlignment(organizationId, now),
  ]);

  const standings = new Map<string, DomainStanding>();
  for (const domain of domainRows) {
    const stall = domainStallView(domain);
    const result = evaluateStanding({
      subject: domain.name,
      counts: current.get(domain.id) ?? EMPTY_COUNTS,
      previousCounts: previous.get(domain.id) ?? EMPTY_COUNTS,
      signals: signals.get(domain.id) ?? null,
      pause: stall ? { reason: stall.summary, since: stall.stalledAt } : null,
      blocklists: named(listings.get(domain.id), domain.name),
      lines,
      dmarc: dmarc.get(domain.id) ?? null,
    });
    standings.set(domain.id, { id: domain.id, name: domain.name, ...result });
  }

  // Like the org guard, the sum skips domains that already carry their own rate finding.
  const covered = new Set(["paused", "stall_pending", "bounce_rate", "complaint_rate", "bounce_count", "complaint_count"]);
  const stalledDomainIds = new Set(
    [...standings.values()].filter((domain) => domain.findings.some((finding) => covered.has(finding.kind))).map((domain) => domain.id),
  );
  const sendingDomains = domainRows.filter((domain) => domain.status === "verified" && current.has(domain.id)).length;
  const firstDomainOn = new Map<string, string>();
  for (const domain of [...domainRows].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!firstDomainOn.has(domain.providerId)) firstDomainOn.set(domain.providerId, domain.id);
  }
  const result = evaluateOrganizationStanding({
    subject: org[0]?.name ?? "This organization",
    sums: organizationSums({ current, previous, stalledDomainIds, lines }),
    sendingDomains,
    suspension: suspension ? { reason: suspension.reason, since: suspension.suspendedAt } : null,
    domains: [...standings.values()].map(({ id, name, standing }) => ({ id, name, standing })),
    providerFindings: findings.map(({ providerId, ...finding }) => {
      const domainId = firstDomainOn.get(providerId);
      return domainId ? { ...finding, domainId } : finding;
    }),
    providerRates: await providerRatesFor(domainRows, standings),
    lines,
  });

  return { ...result, name: org[0]?.name ?? "This organization", domains: standings, lines };
}

/**
 * AWS's own rates for the ordinary providers the organization's domains send through. A tenant's
 * provider-wide rate is everyone's, so it stays on the operator's view.
 */
async function providerRatesFor(domainRows: (typeof domains.$inferSelect)[], standings: Map<string, DomainStanding>): Promise<ProviderRates[]> {
  const providerIds = [...new Set(domainRows.map((domain) => domain.providerId))];
  if (providerIds.length === 0) return [];
  const rates = await readRates(providerIds);
  if (rates.size === 0) return [];
  const rows = await db
    .select({ id: providers.id, name: providers.name, sharedProviderId: providers.sharedProviderId })
    .from(providers)
    .where(inArray(providers.id, [...rates.keys()]));
  return rows.flatMap((provider) => {
    const reading = rates.get(provider.id);
    if (provider.sharedProviderId || reading?.state !== "ok") return [];
    const onProvider = domainRows.filter((domain) => domain.providerId === provider.id).sort((a, b) => a.name.localeCompare(b.name));
    return [
      {
        providerName: provider.name,
        bounceRate: reading.bounceRate,
        complaintRate: reading.complaintRate,
        covered: coveredMetrics(onProvider.flatMap((domain) => standings.get(domain.id)?.findings ?? [])),
        ...(onProvider[0] ? { domainId: onProvider[0].id } : {}),
      },
    ];
  });
}

/** The domain panel: standing, both windows and the reasons behind recent bounces and complaints. */
export async function readDomainReputation(organizationId: string, domainId: string, now: Date): Promise<DomainReputation | null> {
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), eq(domains.id, domainId)))
    .limit(1);
  if (!domain) return null;
  const lines = await readStallLines();

  const windowFor = async (days: number): Promise<ReputationWindow> => {
    const since = new Date(now.getTime() - days * DAY_MS);
    const previousSince = new Date(since.getTime() - days * DAY_MS);
    const [counts, previousCounts] = await Promise.all([
      domainOutcomeWindow(domain, since, now, now),
      domainOutcomeWindow(domain, previousSince, since, now),
    ]);
    return {
      days,
      bounce: readMetric("bounce", counts, previousCounts, lines),
      complaint: readMetric("complaint", counts, previousCounts, lines),
    };
  };

  const [{ signals, ...result }, short, long, reasons, providerFindings, blocklists, tenantVolume] = await Promise.all([
    standingOfDomain(organizationId, domain, now, lines),
    windowFor(STALL_WINDOW_DAYS),
    windowFor(LONG_WINDOW_DAYS),
    recentReasons(organizationId, domainId, new Date(now.getTime() - LONG_WINDOW_DAYS * DAY_MS), now),
    openFindingsOnProvider(domain.providerId),
    readDomainBlocklists(organizationId, domainId, now),
    tenantVolumeOf(domain.providerId),
  ]);

  return {
    ...result,
    name: domain.name,
    signals,
    windows: [short, long],
    reasons,
    providerFindings,
    providerId: domain.providerId,
    blocklists,
    tenantVolume,
  };
}

/** Never fails the read: the counts are a side panel, and SES may be slow or refuse. */
async function tenantVolumeOf(providerId: string): Promise<TenantVolume | null> {
  try {
    const [provider] = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
    return provider ? await readTenantVolume(provider) : null;
  } catch (err) {
    log.warn(`reading tenant counts for ${providerId} failed: ${safeErrorMessage(err)}`);
    return null;
  }
}

/** One domain's standing and nothing else, for API reads. */
export async function readDomainStanding(organizationId: string, domainId: string, now: Date): Promise<StandingResult | null> {
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), eq(domains.id, domainId)))
    .limit(1);
  if (!domain) return null;
  const { signals: _signals, ...result } = await standingOfDomain(organizationId, domain, now, await readStallLines());
  return result;
}

async function standingOfDomain(
  organizationId: string,
  domain: typeof domains.$inferSelect,
  now: Date,
  lines: StallLines,
): Promise<StandingResult & { signals: BehaviorSignals | null }> {
  const guardSince = new Date(now.getTime() - STALL_WINDOW_DAYS * DAY_MS);
  const [counts, previousCounts, signals, listings, dmarc] = await Promise.all([
    domainOutcomeWindow(domain, guardSince, now, now),
    domainOutcomeWindow(domain, new Date(guardSince.getTime() - STALL_WINDOW_DAYS * DAY_MS), guardSince, now),
    readSignals(organizationId, now, [domain.id]),
    readBlocklistListings(organizationId, now, [domain.id]),
    readProviderAlignment(organizationId, now, [domain.id]),
  ]);

  const stall = domainStallView(domain);
  const result = evaluateStanding({
    subject: domain.name,
    counts,
    previousCounts,
    signals: signals.get(domain.id) ?? null,
    pause: stall ? { reason: stall.summary, since: stall.stalledAt } : null,
    blocklists: named(listings.get(domain.id), domain.name),
    lines,
    dmarc: dmarc.get(domain.id) ?? null,
  });
  return { ...result, signals: signals.get(domain.id) ?? null };
}

/** Sending listings carry the domain's own name. */
function named(listings: BlocklistListing[] | undefined, name: string): BlocklistListing[] {
  return (listings ?? []).map((listing) => (listing.source === "sending" ? { ...listing, domain: name } : listing));
}

async function readDomainBlocklists(organizationId: string, domainId: string, now: Date): Promise<DomainBlocklists> {
  const [status, checks, links] = await Promise.all([
    blocklistStatus(now).catch((): BlocklistStatus => ({ state: "no_redis" })),
    domainChecks(organizationId, domainId),
    recentLinkListings(organizationId, now, [domainId]),
  ]);
  return { status, checks, links: links.get(domainId) ?? [] };
}

/** The provider's words for recent bounces and complaints, grouped, most recent first. */
async function recentReasons(organizationId: string, domainId: string, since: Date, until: Date): Promise<RecentReason[]> {
  const rows = await db
    .select({
      status: messageEvents.status,
      reason: messageEvents.reason,
      bounceType: messageEvents.bounceType,
      count: sql<number>`count(*)::int`,
      lastAt: sql<string>`max(${messageEvents.occurredAt})`,
    })
    .from(messageEvents)
    .innerJoin(messages, eq(messages.id, messageEvents.messageId))
    .where(
      and(
        eq(messageEvents.organizationId, organizationId),
        eq(messages.domainId, domainId),
        eq(messages.testMode, false),
        // A literal, so the planner matches message_events_outcome_idx.
        sql`${messageEvents.status} in ('bounced', 'complained')`,
        isNotNull(messageEvents.reason),
        gte(messageEvents.occurredAt, since),
        lt(messageEvents.occurredAt, until),
      ),
    )
    .groupBy(messageEvents.status, messageEvents.reason, messageEvents.bounceType)
    .orderBy(desc(sql`max(${messageEvents.occurredAt})`))
    .limit(RECENT_REASON_LIMIT);

  return rows.flatMap((row) =>
    row.reason && (row.status === "bounced" || row.status === "complained")
      ? [{ status: row.status, reason: row.reason, kind: bounceTypeLabel(row.bounceType), count: row.count, lastAt: new Date(row.lastAt) }]
      : [],
  );
}
