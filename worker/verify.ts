import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, providers, type DomainStatus } from "@/lib/db/schema";
import { adapterFor, type ProviderRow } from "@/lib/providers";
import { cancelPendingBinding, configureEvents } from "@/lib/domains";
import { nextVerificationState, providerAnswered } from "@/lib/domains/verification";
import { moveInboundRoute } from "@/lib/inbound/manage";
import { logger } from "@/lib/logger";
import { sendDomainVerificationFailedAlert } from "@/lib/mail/alerts/domain-verification-failed";
import { ADAPTER_KEYS } from "@/lib/providers/adapters";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker:verify");

/** A domain pending longer than the slow interval is unlikely to resolve in the next five minutes. */
export const DEFAULT_SLOW_RECHECK_MS = 60 * 60 * 1000;

/**
 * How long a pending move to another provider waits for its DNS before the loop gives up
 * and cancels it on its own. Nobody publishing records for two weeks means the move was
 * abandoned, not just slow — and an abandoned move shouldn't sit here forever holding an identity
 * open at the target provider.
 */
export const DEFAULT_PENDING_EXPIRES_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * How long a verified domain is left alone before the loop asks its provider again. DNS
 * underneath a verified domain can change without Pouch ever hearing about it — a record
 * pulled, a zone migrated — so this is what turns "verification failed after having been
 * verified" from undetectable into a slow, cheap poll. A day, not the fast/slow pending
 * intervals: a verified domain isn't waiting on anything, so there's no reason to ask often.
 */
export const DEFAULT_VERIFIED_RECHECK_MS = 24 * 60 * 60 * 1000;

/**
 * Statuses the loop re-asks about. A failed domain recovers on its own once the DNS is fixed.
 * A verified domain is re-asked too, on the much slower `verifiedRecheckAfterMs` interval, so a
 * domain that stops verifying after DNS changes underneath it doesn't sit unnoticed forever.
 */
const RECHECKED = ["pending", "failed", "verified"] as const;

export interface VerifyLoopOptions {
  /** Defaults for a single-loop test harness that has no worker process around it. */
  workerId?: string;
  /** How often the loop wakes up. */
  intervalMs: number;
  /** Domains checked per pass. */
  batchSize: number;
  /** How long to leave a new domain alone after a check. */
  recheckAfterMs: number;
  /** How long to leave a domain alone once it's been pending this long. */
  slowRecheckAfterMs?: number;
  /** How long a pending provider move waits for its DNS before it's cancelled. */
  pendingExpiresAfterMs?: number;
  /** How long a verified domain is left alone before it's asked about again. */
  verifiedRecheckAfterMs?: number;
}

type DomainRow = typeof domains.$inferSelect;

export interface RecheckWindow {
  createdAt: Date;
  now: Date;
  fastMs: number;
  slowMs: number;
  status: DomainStatus;
}

/**
 * The cutoff a domain's last check has to predate to be asked about again. A domain pending past
 * the slow interval, and a failed domain whatever its age, are polled at the slow interval.
 */
export function recheckDueBefore(window: RecheckWindow): Date {
  const pendingFor = window.now.getTime() - window.createdAt.getTime();
  const slow = window.status === "failed" || pendingFor >= window.slowMs;
  return new Date(window.now.getTime() - (slow ? window.slowMs : window.fastMs));
}

/** Whether an adapter can answer a verification check at all. */
function checkable(adapter: string): boolean {
  return ADAPTER_KEYS.includes(adapter);
}

/**
 * Re-asks each pending or failed domain's provider where verification stands. Provider backoff is
 * a sending limit, not a reason to stop asking, so this loop ignores it.
 */
export class VerifyLoop extends IntervalLoop<number> {
  protected readonly name = "verify";
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;

  constructor(private readonly options: VerifyLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<number> {
    const fastSeconds = this.options.recheckAfterMs / 1000;
    const slowSeconds = (this.options.slowRecheckAfterMs ?? DEFAULT_SLOW_RECHECK_MS) / 1000;
    const verifiedSeconds = (this.options.verifiedRecheckAfterMs ?? DEFAULT_VERIFIED_RECHECK_MS) / 1000;

    const rows = await db
      .select({ domain: domains, provider: providers })
      .from(domains)
      .innerJoin(providers, eq(providers.id, domains.providerId))
      .where(
        and(
          inArray(domains.status, RECHECKED),
          or(
            // A verified domain always gets lastCheckedAt stamped the moment it verifies (this
            // loop's own write, or the instant dashboard verify), so null here means it hasn't
            // gone through either path yet — nothing to recheck. Excluding it keeps a freshly
            // verified domain from being asked about again on the very next tick.
            and(isNull(domains.lastCheckedAt), sql`${domains.status} <> 'verified'`),
            sql`${domains.lastCheckedAt} <= now() - make_interval(secs => (
              case
                when ${domains.status} = 'verified' then ${verifiedSeconds}::double precision
                when ${domains.status} = 'failed' or ${domains.createdAt} <= now() - make_interval(secs => ${slowSeconds}::double precision) then ${slowSeconds}::double precision
                else ${fastSeconds}::double precision
              end
            ))`,
          ),
        ),
      )
      // Never-checked domains first, then the ones waiting longest.
      .orderBy(sql`${domains.lastCheckedAt} asc nulls first`)
      .limit(this.options.batchSize);

    // An adapter that can't be asked still gets stamped, or its rows refill the batch every pass.
    const skipped = rows.filter((row) => !checkable(row.provider.adapter)).map((row) => row.domain.id);
    if (skipped.length > 0) {
      const now = await dbNow();
      await db.update(domains).set({ lastCheckedAt: now }).where(inArray(domains.id, skipped));
      log.warn(`skipped ${skipped.length} domain(s) whose provider can't be asked about verification`);
    }

    let checked = 0;
    for (const row of rows) {
      if (this.stopped) break;
      if (!checkable(row.provider.adapter)) continue;
      checked += 1;
      await this.checkOne(row.domain, row.provider);
    }

    if (!this.stopped) checked += await this.checkPendingBindings();
    return checked;
  }

  /**
   * Re-asks each pending move's target provider where verification stands. Rides the same loop
   * rather than growing its own, per #35 — a pending binding is just another thing due for a
   * check, on the provider it's moving to instead of the one it's currently sending on.
   */
  private async checkPendingBindings(): Promise<number> {
    const fastSeconds = this.options.recheckAfterMs / 1000;
    const slowSeconds = (this.options.slowRecheckAfterMs ?? DEFAULT_SLOW_RECHECK_MS) / 1000;
    const expiresMs = this.options.pendingExpiresAfterMs ?? DEFAULT_PENDING_EXPIRES_MS;

    const rows = await db
      .select({ domain: domains, provider: providers })
      .from(domains)
      .innerJoin(providers, eq(providers.id, domains.pendingProviderId))
      .where(
        and(
          isNotNull(domains.pendingProviderId),
          or(
            isNull(domains.pendingLastCheckedAt),
            sql`${domains.pendingLastCheckedAt} <= now() - make_interval(secs => (case when ${domains.pendingStartedAt} <= now() - make_interval(secs => ${slowSeconds}::double precision) then ${slowSeconds}::double precision else ${fastSeconds}::double precision end))`,
          ),
        ),
      )
      .orderBy(sql`${domains.pendingLastCheckedAt} asc nulls first`)
      .limit(this.options.batchSize);

    let checked = 0;
    for (const row of rows) {
      if (this.stopped) break;

      const startedAt = row.domain.pendingStartedAt ?? row.domain.updatedAt;
      if (Date.now() - startedAt.getTime() > expiresMs) {
        log.warn(`pending move for ${row.domain.name} to ${row.provider.id} expired unverified — cancelling it`);
        try {
          await cancelPendingBinding(row.domain, await dbNow());
        } catch (err) {
          log.warn(`cancelling the pending move for ${row.domain.name} failed, retrying later: ${safeErrorMessage(err)}`);
          await db.update(domains).set({ pendingLastCheckedAt: await dbNow() }).where(eq(domains.id, row.domain.id));
        }
        checked += 1;
        continue;
      }

      if (!checkable(row.provider.adapter)) {
        const now = await dbNow();
        await db.update(domains).set({ pendingLastCheckedAt: now }).where(eq(domains.id, row.domain.id));
        continue;
      }

      checked += 1;
      await this.checkPendingOne(row.domain, row.provider);
    }
    return checked;
  }

  /**
   * Checks one pending binding's target provider. Verified with nothing missing cuts the domain
   * over: `provider_id` swaps to the target, its DNS records become the live ones, and
   * the pending fields clear. Anything else short of that leaves the live binding untouched —
   * the domain keeps sending on its current provider the whole time (#35).
   */
  private async checkPendingOne(domain: DomainRow, provider: ProviderRow): Promise<void> {
    const now = await dbNow();
    try {
      const status = await adapterFor(provider).domain.verify(domain.name, domain.pendingProviderDomainId);
      if (!providerAnswered(status)) {
        await db.update(domains).set({ pendingLastCheckedAt: now }).where(eq(domains.id, domain.id));
        return;
      }

      if (status.verified && status.missing.length === 0) {
        // configureEvents already ran when the move was requested, and is a no-op here either way.
        await configureEvents(provider, domain.name);
        await db
          .update(domains)
          .set({
            providerId: provider.id,
            providerDomainId: domain.pendingProviderDomainId,
            dnsRecords: domain.pendingDnsRecords,
            missingRecords: [],
            status: "verified",
            verifiedAt: now,
            verificationErrors: [],
            lastCheckedAt: now,
            pendingProviderId: null,
            pendingProviderDomainId: null,
            pendingDnsRecords: [],
            pendingMissingRecords: [],
            pendingStartedAt: null,
            pendingLastCheckedAt: null,
            updatedAt: now,
          })
          .where(eq(domains.id, domain.id));
        log.info(`cut ${domain.name} over to provider ${provider.id}`);
        const [from] = await db.select().from(providers).where(eq(providers.id, domain.providerId)).limit(1);
        if (from) await moveInboundRoute(domain, from, provider);
        return;
      }

      await db
        .update(domains)
        .set({ pendingMissingRecords: status.missing, pendingLastCheckedAt: now, updatedAt: now })
        .where(eq(domains.id, domain.id));
    } catch (err) {
      log.warn(`checking the pending move for ${domain.name} threw: ${safeErrorMessage(err)}`);
      await db.update(domains).set({ pendingLastCheckedAt: now }).where(eq(domains.id, domain.id));
    }
  }

  private async checkOne(domain: DomainRow, provider: ProviderRow): Promise<void> {
    // last_checked_at decides the next due time against `now()`, so it comes from that clock.
    const now = await dbNow();
    try {
      const status = await adapterFor(provider).domain.verify(domain.name, domain.providerDomainId);
      const next = providerAnswered(status) ? nextVerificationState(status, domain, now) : null;
      await db
        .update(domains)
        .set({
          ...(next ?? {}),
          lastCheckedAt: now,
          updatedAt: now,
        })
        .where(eq(domains.id, domain.id));
      if (status.verified) log.info(`verified ${domain.name}`);
      else if (next?.status === "failed") log.warn(`${domain.name} failed verification: ${next.verificationErrors.join("; ")}`);

      // domain.status is the row as read before this check, so this only fires the moment DNS
      // breaks underneath a domain that was verified — not on every recheck of an already-failed
      // one. Best-effort: a notification failing here must never undo the status write above.
      if (domain.status === "verified" && next?.status === "failed") {
        await sendDomainVerificationFailedAlert(domain, next.verificationErrors).catch((err) => {
          const reason = safeErrorMessage(err);
          log.warn(`couldn't send the verification-failed alert for ${domain.name}: ${reason}`);
        });
      }
    } catch (err) {
      // The timestamp lands either way, so one broken domain can't be re-asked every pass.
      log.warn(`verifying ${domain.name} threw: ${safeErrorMessage(err)}`);
      await db.update(domains).set({ lastCheckedAt: now, updatedAt: now }).where(eq(domains.id, domain.id));
    }
  }

}
