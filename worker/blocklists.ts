import { dbNow } from "@/lib/db/clock";
import { logger } from "@/lib/logger";
import { checkDomain, checkKey, domainsDueForBlocklistCheck, sweepEnabled } from "@/lib/blocklists/domains";
import { readKeyProblem } from "@/lib/blocklists/status";
import { checkReputation } from "@/lib/reputation/transitions";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker:blocklists");

export interface BlocklistLoopOptions {
  workerId?: string;
  intervalMs: number;
  /** Domains checked per pass. */
  batchSize: number;
}

/**
 * Checks each verified sending domain against the domain blocklists once a day, after confirming
 * the key works on Spamhaus's test entry. A listing change syncs the organization's standing.
 */
export class BlocklistLoop extends IntervalLoop<number> {
  protected readonly name = "blocklists";
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;

  constructor(private readonly options: BlocklistLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<number> {
    if (!sweepEnabled()) return 0;
    const now = await dbNow();
    const due = await domainsDueForBlocklistCheck(now, this.options.batchSize);
    // A failing key is retested every pass, so link checks resume without waiting for a due domain.
    if (due.length === 0 && !(await readKeyProblem())) return 0;
    if ((await checkKey(now)) !== "ok" || due.length === 0) return 0;

    let checked = 0;
    const changed = new Set<string>();
    for (const domain of due) {
      if (this.stopped) break;
      try {
        const result = await checkDomain(domain, now);
        checked += 1;
        if (result.changed) changed.add(domain.organizationId);
        if (result.stopped || result.keyFailed) break;
      } catch (err) {
        log.warn(`checking ${domain.name} threw: ${safeErrorMessage(err)}`);
      }
    }

    for (const organizationId of changed) {
      await checkReputation(organizationId, now).catch((err: unknown) => {
        log.warn(`syncing reputation for organization ${organizationId} threw: ${safeErrorMessage(err)}`);
      });
    }
    return checked;
  }
}
