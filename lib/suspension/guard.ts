/** The domain stall's evaluation over an organization's domains summed, minus domains it already covers. */
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messages, organizations } from "@/lib/db/schema";
import { workerActor } from "@/lib/activity/record";
import { describeStall, evaluateStall, type StallLines, type StallVerdict } from "@/lib/domains/guard";
import { readStallLines } from "@/lib/domains/stall";
import { EMPTY_COUNTS, type OutcomeCounts } from "@/lib/metrics/rates";
import { readOutcomes } from "@/lib/stats/outcomes";
import { suspendOrganization } from "./index";

export type CountsByDomain = Map<string, OutcomeCounts>;

function add(a: OutcomeCounts, b: OutcomeCounts): OutcomeCounts {
  return {
    total: a.total + b.total,
    delivered: a.delivered + b.delivered,
    bounced: a.bounced + b.bounced,
    complained: a.complained + b.complained,
    failed: a.failed + b.failed,
    inFlight: a.inFlight + b.inFlight,
    queued: a.queued + b.queued,
  };
}

export interface OrganizationStallInput {
  current: CountsByDomain;
  previous: CountsByDomain;
  /** Domains the domain guard already holds. */
  stalledDomainIds: ReadonlySet<string>;
  lines: StallLines;
}

/** The organization's counts, minus domains the domain guard holds or is about to. */
export function organizationSums(input: OrganizationStallInput): { counts: OutcomeCounts; previousCounts: OutcomeCounts } {
  let counts = EMPTY_COUNTS;
  let previousCounts = EMPTY_COUNTS;
  const domainIds = new Set([...input.current.keys(), ...input.previous.keys()]);

  for (const domainId of domainIds) {
    if (input.stalledDomainIds.has(domainId)) continue;
    const current = input.current.get(domainId) ?? EMPTY_COUNTS;
    const previous = input.previous.get(domainId) ?? EMPTY_COUNTS;
    if (evaluateStall({ counts: current, previousCounts: previous, lines: input.lines })) continue;
    counts = add(counts, current);
    previousCounts = add(previousCounts, previous);
  }

  return { counts, previousCounts };
}

export function evaluateOrganizationStall(input: OrganizationStallInput): StallVerdict | null {
  return evaluateStall({ ...organizationSums(input), lines: input.lines });
}

/** Per-domain counts for one organization and window, test mode excluded like the domain guard. */
export async function organizationOutcomesByDomain(organizationId: string, since: Date, until: Date, now: Date): Promise<CountsByDomain> {
  return readOutcomes({ organizationId }, since, until, now);
}

export interface OrganizationDue {
  id: string;
  name: string;
}

/** Unsuspended organizations with two or more verified domains that have sent, oldest-checked first. */
export async function organizationsDueForSuspensionCheck(checkedBefore: Date, limit: number): Promise<OrganizationDue[]> {
  const sendingDomains = sql<number>`(
    select count(*) from ${domains}
    where ${domains.organizationId} = ${organizations.id}
      and ${domains.status} = 'verified'
      and exists (select 1 from ${messages} where ${messages.domainId} = ${domains.id} limit 1)
  )`;
  return db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(
      and(
        isNull(organizations.suspendedAt),
        or(isNull(organizations.suspensionCheckedAt), lt(organizations.suspensionCheckedAt, checkedBefore)),
        sql`${sendingDomains} >= 2`,
      ),
    )
    .orderBy(asc(sql`coalesce(${organizations.suspensionCheckedAt}, ${organizations.createdAt})`))
    .limit(limit);
}

export async function stalledDomainIdsOf(organizationId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), sql`${domains.stalledAt} is not null`));
  return new Set(rows.map((row) => row.id));
}

export async function markSuspensionChecked(organizationId: string, now: Date): Promise<void> {
  await db.update(organizations).set({ suspensionCheckedAt: now }).where(eq(organizations.id, organizationId));
}

/** Evaluates one organization over two consecutive windows and suspends it when the sum crosses. */
export async function checkOrganizationStall(organizationId: string, windowMs: number, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - windowMs);
  const previousSince = new Date(since.getTime() - windowMs);
  const [current, previous, stalledDomainIds, lines] = await Promise.all([
    organizationOutcomesByDomain(organizationId, since, now, now),
    organizationOutcomesByDomain(organizationId, previousSince, since, now),
    stalledDomainIdsOf(organizationId),
    readStallLines(),
  ]);

  const verdict = evaluateOrganizationStall({ current, previous, stalledDomainIds, lines });
  if (!verdict) return false;

  return suspendOrganization(
    organizationId,
    {
      source: "reputation",
      reason: describeStall(verdict.reason, verdict.detail),
      detail: { reason: verdict.reason, ...verdict.detail },
    },
    workerActor("Reputation guard"),
    now,
  );
}
