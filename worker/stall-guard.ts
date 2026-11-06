import { dbNow } from "@/lib/db/clock";
import { checkDmarcPolicyReady } from "@/lib/dmarc/ready";
import { evaluateStall, STALL_WINDOW_DAYS } from "@/lib/domains/guard";
import { domainOutcomeWindow, domainsDueForStallCheck, markStallChecked, readStallLines, stallDomain } from "@/lib/domains/stall";
import { logger } from "@/lib/logger";
import { notifyObservations } from "@/lib/notifications/observations";
import { checkOrganizationStall, markSuspensionChecked, organizationsDueForSuspensionCheck } from "@/lib/suspension/guard";
import { checkProviderIdentityRollup } from "@/lib/suspension/rollup";
import { pruneSuppressedRejections } from "@/lib/reputation/signals";
import { checkReputation } from "@/lib/reputation/transitions";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker:stall-guard");

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StallGuardOptions {
  /** Which worker this loop belongs to. The heartbeat is per worker, so replicas must differ. */
  workerId?: string;
  /** How often the loop wakes up. */
  intervalMs: number;
  /** Domains evaluated per pass. */
  batchSize: number;
  /** How long a check stands before the domain is due again. */
  recheckAfterMs: number;
}

/**
 * Reads each verified domain's recent bounce and complaint activity and stalls the ones that
 * cross our own action point (`lib/domains/guard.ts`) — a level, a rising trend, or a small
 * absolute count too low-volume for a rate to mean anything. State lives on the domain row
 * (`stalled_at`), so the send path never recomputes a rate per message; this loop is the one
 * place that does the arithmetic.
 *
 * Also runs the org-level stall, the provider-identity rollup (`lib/suspension/`) and the
 * reputation standing check, the DMARC policy nudge and observation email for the organizations it touched.
 *
 * Never clears a stall on its own — see `releaseDomainStall`. A rate recovering because sending
 * paused isn't evidence the underlying problem is fixed.
 */
export class StallGuardLoop extends IntervalLoop<number> {
  protected readonly name = "stall-guard";
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;
  private lastRollupAt = 0;
  /** When each organization's observations were last emailed from this process. */
  private readonly observedAt = new Map<string, number>();

  constructor(private readonly options: StallGuardOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<number> {
    const now = await dbNow();
    const dueBefore = new Date(now.getTime() - this.options.recheckAfterMs);
    const [domains, lines] = await Promise.all([domainsDueForStallCheck(dueBefore, this.options.batchSize), readStallLines()]);

    let checked = 0;
    for (const domain of domains) {
      if (this.stopped) break;
      checked += 1;

      try {
        const windowMs = STALL_WINDOW_DAYS * DAY_MS;
        const until = now;
        const since = new Date(until.getTime() - windowMs);
        const previousSince = new Date(since.getTime() - windowMs);

        const [counts, previousCounts] = await Promise.all([
          domainOutcomeWindow(domain, since, until, now),
          domainOutcomeWindow(domain, previousSince, since, now),
        ]);

        const verdict = evaluateStall({ counts, previousCounts, lines });
        if (verdict) await stallDomain(domain, verdict, now);
      } catch (err) {
        log.warn(`checking ${domain.name} threw: ${safeErrorMessage(err)}`);
      } finally {
        await markStallChecked(domain.id, now);
      }
    }

    for (const organization of await organizationsDueForSuspensionCheck(dueBefore, this.options.batchSize)) {
      if (this.stopped) break;
      checked += 1;
      try {
        await checkOrganizationStall(organization.id, STALL_WINDOW_DAYS * DAY_MS, now);
      } catch (err) {
        log.warn(`checking organization ${organization.name} threw: ${safeErrorMessage(err)}`);
      } finally {
        await markSuspensionChecked(organization.id, now);
      }
    }

    const organizationIds = new Set(domains.map((domain) => domain.organizationId));
    for (const organizationId of organizationIds) {
      if (this.stopped) break;
      try {
        await checkReputation(organizationId, now);
      } catch (err) {
        log.warn(`checking reputation for organization ${organizationId} threw: ${safeErrorMessage(err)}`);
      }
      await checkDmarcPolicyReady(organizationId, now).catch((err: unknown) => {
        log.warn(`checking DMARC policy for organization ${organizationId} threw: ${safeErrorMessage(err)}`);
      });
      if (now.getTime() - (this.observedAt.get(organizationId) ?? 0) >= this.options.recheckAfterMs) {
        this.observedAt.set(organizationId, now.getTime());
        await notifyObservations(organizationId, now).catch((err: unknown) => {
          log.warn(`emailing observations for organization ${organizationId} threw: ${safeErrorMessage(err)}`);
        });
      }
    }

    if (!this.stopped && now.getTime() - this.lastRollupAt >= this.options.recheckAfterMs) {
      this.lastRollupAt = now.getTime();
      await checkProviderIdentityRollup().catch((err: unknown) => {
        log.warn(`provider identity rollup threw: ${safeErrorMessage(err)}`);
      });
      await pruneSuppressedRejections(now).catch((err: unknown) => {
        log.warn(`pruning suppressed rejections threw: ${safeErrorMessage(err)}`);
      });
    }

    return checked;
  }

}
