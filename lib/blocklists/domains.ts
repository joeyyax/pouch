/** The daily check of each verified sending domain. */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domainBlocklistChecks, domains, type DomainBlocklistCheckRow } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { queryList } from "./check";
import { BLOCKLISTS, DBL_TEST_CODE, DBL_TEST_DOMAIN, type BlocklistId } from "./lists";
import { clearKeyProblem, dqsKey, markKeyProblem } from "./status";

const log = logger.child("blocklists:domains");

export const DOMAIN_RECHECK_MS = 24 * 60 * 60 * 1000;
export const SWEEP_LOOKUP_TIMEOUT_MS = 3_000;
const HOUR_MS = 60 * 60 * 1000;

export type KeyCheck = "ok" | "failing" | "unknown";

/**
 * Queries Spamhaus's DBL test entry. A wrong answer, including no listing at all, means the key or
 * resolver isn't working, and nothing checked with it can be trusted.
 */
export async function checkKey(now: Date): Promise<KeyCheck> {
  const outcome = await queryList("dbl", DBL_TEST_DOMAIN, "sweep", now, SWEEP_LOOKUP_TIMEOUT_MS);
  if (outcome.kind === "skipped") return "unknown";
  if (outcome.kind === "listed" && outcome.code === DBL_TEST_CODE) {
    await clearKeyProblem();
    return "ok";
  }
  if (outcome.kind === "error" && (outcome.error === "timeout" || outcome.error === "lookup_failed")) return "unknown";
  if (outcome.kind === "clear") await markKeyProblem("key_invalid", null, now);
  else if (outcome.kind === "error") await markKeyProblem(outcome.error, outcome.code ?? null, now);
  else await markKeyProblem("unexpected_code", outcome.code, now);
  return "failing";
}

export interface DueDomain {
  id: string;
  name: string;
  organizationId: string;
}

/** Verified domains whose last answer on any list is older than a day, or missing. */
export async function domainsDueForBlocklistCheck(now: Date, limit: number): Promise<DueDomain[]> {
  const before = new Date(now.getTime() - DOMAIN_RECHECK_MS);
  // Failed checks wait an hour so a flaky resolver doesn't spend the budget in one pass.
  const retryBefore = new Date(now.getTime() - HOUR_MS);
  const lists = sql.join(BLOCKLISTS.map((list) => sql`(${list})`), sql`, `);
  const rows = await db.execute<{ id: string; name: string; organization_id: string }>(sql`
    select d.id, d.name, d.organization_id
    from ${domains} d
    cross join (values ${lists}) as l(list)
    left join ${domainBlocklistChecks} c on c.domain_id = d.id and c.list = l.list
    where d.status = 'verified'
      and (c.checked_at is null or c.checked_at < ${before.toISOString()}::timestamptz)
      and (c.last_error_at is null or c.last_error_at < ${retryBefore.toISOString()}::timestamptz)
    group by d.id, d.name, d.organization_id
    order by min(coalesce(c.checked_at, 'epoch'::timestamptz)), d.id
    limit ${limit}
  `);
  return rows.map((row) => ({ id: row.id, name: row.name, organizationId: row.organization_id }));
}

export interface DomainCheckResult {
  /** A list's listing started, ended or changed code. */
  changed: boolean;
  /** The budget ran out; stop the pass. */
  stopped: boolean;
  keyFailed: boolean;
}

async function existingChecks(domainId: string): Promise<Map<BlocklistId, DomainBlocklistCheckRow>> {
  const rows = await db.select().from(domainBlocklistChecks).where(eq(domainBlocklistChecks.domainId, domainId));
  return new Map(rows.map((row) => [row.list, row]));
}

export async function checkDomain(domain: DueDomain, now: Date): Promise<DomainCheckResult> {
  const result: DomainCheckResult = { changed: false, stopped: false, keyFailed: false };
  const existing = await existingChecks(domain.id);

  for (const list of BLOCKLISTS) {
    const outcome = await queryList(list, domain.name, "sweep", now, SWEEP_LOOKUP_TIMEOUT_MS);
    const previous = existing.get(list);
    const key = { organizationId: domain.organizationId, domainId: domain.id, list };

    if (outcome.kind === "skipped") {
      if (outcome.why === "budget") result.stopped = true;
      if (outcome.why === "bad_name") log.warn(`${domain.name} isn't a queryable name`);
      break;
    }

    if (outcome.kind === "error") {
      if (outcome.error === "refused" || outcome.error === "key_invalid" || outcome.error === "rate_limited") {
        await markKeyProblem(outcome.error, outcome.code ?? null, now);
        result.keyFailed = true;
      }
      const error = outcome.code ? `${outcome.error} (${outcome.code})` : outcome.error;
      if (previous) {
        await db
          .update(domainBlocklistChecks)
          .set({ lastError: error, lastErrorAt: now })
          .where(and(eq(domainBlocklistChecks.domainId, domain.id), eq(domainBlocklistChecks.list, list)));
      } else {
        await db
          .insert(domainBlocklistChecks)
          .values({ ...key, lastError: error, lastErrorAt: now })
          .onConflictDoNothing();
      }
      log.warn(`checking ${domain.name} on ${list} failed: ${error}`);
      if (result.keyFailed) break;
      continue;
    }

    const listed = outcome.kind === "listed";
    const values = {
      status: listed ? ("listed" as const) : ("clear" as const),
      code: listed ? outcome.code : null,
      reason: listed ? outcome.reason : null,
      checkedAt: now,
      listedSince: listed ? (previous?.status === "listed" && previous.listedSince ? previous.listedSince : now) : null,
      expiresAt: listed && outcome.ageHours !== undefined ? new Date(now.getTime() + (24 - outcome.ageHours) * HOUR_MS) : null,
      lastError: null,
      lastErrorAt: null,
    };
    await db
      .insert(domainBlocklistChecks)
      .values({ ...key, ...values })
      .onConflictDoUpdate({ target: [domainBlocklistChecks.domainId, domainBlocklistChecks.list], set: values });

    const wasListed = previous?.status === "listed";
    if (listed !== wasListed || (listed && previous?.code !== outcome.code)) {
      result.changed = true;
      if (listed) log.warn(`${domain.name} is listed on ${list}: ${outcome.reason} (${outcome.code})`);
      else log.info(`${domain.name} is no longer listed on ${list}`);
    }
  }
  return result;
}

/** Sending domains with a listing that hasn't lapsed, keyed by domain id. */
export async function activeDomainListings(organizationId: string, now: Date, domainIds?: string[]): Promise<Map<string, DomainBlocklistCheckRow[]>> {
  const rows = await db
    .select()
    .from(domainBlocklistChecks)
    .where(
      and(
        eq(domainBlocklistChecks.organizationId, organizationId),
        eq(domainBlocklistChecks.status, "listed"),
        or(sql`${domainBlocklistChecks.expiresAt} is null`, sql`${domainBlocklistChecks.expiresAt} > ${now.toISOString()}::timestamptz`),
        ...(domainIds ? [inArray(domainBlocklistChecks.domainId, domainIds)] : []),
      ),
    );
  const byDomain = new Map<string, DomainBlocklistCheckRow[]>();
  for (const row of rows) byDomain.set(row.domainId, [...(byDomain.get(row.domainId) ?? []), row]);
  return byDomain;
}

/** Every list's last answer for one domain, for the reputation page. */
export async function domainChecks(organizationId: string, domainId: string): Promise<DomainBlocklistCheckRow[]> {
  return db
    .select()
    .from(domainBlocklistChecks)
    .where(and(eq(domainBlocklistChecks.organizationId, organizationId), eq(domainBlocklistChecks.domainId, domainId)));
}

/** True when checks can run at all. */
export function sweepEnabled(): boolean {
  return dqsKey() !== null;
}
