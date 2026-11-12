/**
 * The stall guard's database edge: the counts it reads, and the write that holds or releases a
 * domain, and the lines it reads. Evaluation itself (`evaluateStall`) is pure — see guard.ts.
 */
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import { messages } from "@/lib/db/schema/messages";
import type { OutcomeCounts } from "@/lib/metrics/rates";
import { readDomainOutcomes } from "@/lib/stats/outcomes";
import { recordActivity, workerActor } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { sendDomainStalledAlert } from "@/lib/notifications/push/domain-stalled";
import { readSettingValues } from "@/lib/settings/values";
import { isStalled, releaseCovers, stallLines, type StallDetail, type StallLines, type StallReason, type StallVerdict } from "./guard";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("domains:stall");

/** The stall lines as the registry has them now. Every threshold reader starts here. */
export async function readStallLines(): Promise<StallLines> {
  return stallLines(await readSettingValues());
}

export type DomainRow = typeof domains.$inferSelect;

export interface DomainStallState {
  stalledAt: Date;
  reason: StallReason;
  detail: StallDetail | null;
}

/**
 * Delivered/bounced/complained/failed for one domain over one window. Test-mode messages count
 * toward neither rate — `bounce@` and friends in test mode are a developer poking at delivery
 * handling, not a signal about the domain's real senders.
 */
export async function domainOutcomeWindow(
  domain: Pick<DomainRow, "id" | "organizationId">,
  since: Date,
  until: Date,
  now: Date,
): Promise<OutcomeCounts> {
  return readDomainOutcomes(domain.organizationId, domain.id, since, until, now);
}

/** Verified domains that have sent anything and weren't checked since `checkedBefore`, oldest-checked first — a domain nothing sends from has nothing to guard. */
export async function domainsDueForStallCheck(checkedBefore: Date, limit: number): Promise<DomainRow[]> {
  return db
    .select()
    .from(domains)
    .where(
      and(
        eq(domains.status, "verified"),
        or(isNull(domains.stallCheckedAt), lt(domains.stallCheckedAt, checkedBefore)),
        sql`exists (select 1 from ${messages} where ${messages.domainId} = ${domains.id} limit 1)`,
      ),
    )
    .orderBy(sql`coalesce(${domains.stallCheckedAt}, ${domains.createdAt}) asc`)
    .limit(limit);
}

/**
 * Stalls the queue for a domain that isn't already held. A domain already stalled keeps its
 * original reason and timestamp — a second, different trigger while it's down doesn't reset the
 * clock an operator is reading, and doesn't overwrite the numbers that first explained it.
 */
export async function stallDomain(domain: DomainRow, verdict: StallVerdict, now: Date): Promise<boolean> {
  if (domain.stalledAt) return false;
  const release =
    domain.stallReleasedAt && domain.stallReleasedDetail
      ? { releasedAt: domain.stallReleasedAt, detail: domain.stallReleasedDetail }
      : null;
  if (releaseCovers(release, verdict, now)) return false;

  const updated = await db
    .update(domains)
    .set({
      stalledAt: now,
      stallReason: verdict.reason,
      stallDetail: verdict.detail,
      updatedAt: now,
    })
    .where(and(eq(domains.id, domain.id), isNull(domains.stalledAt)))
    .returning({ id: domains.id });

  if (updated.length === 0) return false;

  log.warn(`stalled ${domain.name}: ${verdict.reason}`, verdict.detail);
  await recordActivity({
    organizationId: domain.organizationId,
    action: "domain.stalled",
    actor: workerActor("Reputation guard"),
    appliesTo: domain.id,
    subjectLabel: domain.name,
    metadata: { reason: verdict.reason, ...verdict.detail },
  });

  // This branch only runs on the write that actually flips the domain to stalled — the isNull
  // guard above means a worker restart mid-stall re-reads a domain that's already held and never
  // gets here again. That's what keeps the push to exactly once; best-effort, so a push failure
  // can't undo the hold it's reporting on.
  await sendDomainStalledAlert(domain, verdict).catch((err) => {
    log.warn(`couldn't send the stalled push alert for ${domain.name}: ${safeErrorMessage(err)}`);
  });

  return true;
}

/** Stamps the check without stalling — so a healthy domain isn't re-scanned ahead of one waiting longer. */
export async function markStallChecked(domainId: string, now: Date): Promise<void> {
  await db.update(domains).set({ stallCheckedAt: now }).where(eq(domains.id, domainId));
}

/**
 * Clears a stall. Manual only — nothing in this codebase clears one on its own, because a rate
 * that recovers while sending is paused isn't evidence the underlying problem is fixed.
 * Keeps the numbers it cleared so `stallDomain` doesn't hold the domain again on them.
 */
export async function releaseDomainStall(
  organizationId: string,
  domainId: string,
  actor: ActivityActor,
  now: Date,
): Promise<DomainRow> {
  const [existing] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.organizationId, organizationId)))
    .limit(1);
  if (!existing) throw new ApiError("not_found", `No domain with id ${domainId}.`);
  if (!existing.stalledAt) return existing;

  const [updated] = await db
    .update(domains)
    .set({
      stalledAt: null,
      stallReason: null,
      stallDetail: null,
      stallReleasedAt: existing.stallDetail ? now : null,
      stallReleasedDetail: existing.stallDetail,
      updatedAt: now,
    })
    .where(eq(domains.id, domainId))
    .returning();
  if (!updated) throw new ApiError("not_found", `No domain with id ${domainId}.`);

  await recordActivity({
    organizationId,
    action: "domain.stall.released",
    actor,
    appliesTo: updated.id,
    subjectLabel: updated.name,
  });

  return updated;
}

/** Which of these domains are currently stalled, keyed by id. Used by the send loop to hold their claims. */
export async function stallStateFor(domainIds: string[]): Promise<Map<string, DomainStallState>> {
  if (domainIds.length === 0) return new Map();
  const rows = await db
    .select({ id: domains.id, stalledAt: domains.stalledAt, stallReason: domains.stallReason, stallDetail: domains.stallDetail })
    .from(domains)
    .where(and(inArray(domains.id, domainIds), sql`${domains.stalledAt} is not null`));

  const result = new Map<string, DomainStallState>();
  for (const row of rows) {
    if (!isStalled(row)) continue;
    result.set(row.id, { stalledAt: row.stalledAt, reason: row.stallReason, detail: row.stallDetail });
  }
  return result;
}
