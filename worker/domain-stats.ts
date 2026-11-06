import { dbNow } from "@/lib/db/clock";
import { logger } from "@/lib/logger";
import { computeDomainStats, pruneDomainStats } from "@/lib/domains/daily-stats";
import { rollupMessageStats } from "@/lib/stats/rollup";
import { IntervalLoop } from "@/lib/worker/interval-loop";

const log = logger.child("worker:domain-stats");

export interface DomainStatsLoopOptions {
  workerId?: string;
  intervalMs: number;
}

/** Upserts today's row of every domain's rolling delivery and volume stats, drops rows past 90 days, then rolls up message hours. */
export class DomainStatsLoop extends IntervalLoop<number> {
  protected readonly name = "domain-stats";
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;

  constructor(options: DomainStatsLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<number> {
    const now = await dbNow();
    const written = await computeDomainStats(now);
    const pruned = await pruneDomainStats(now);
    if (pruned > 0) log.info(`dropped ${pruned} domain stats rows past retention`);
    await rollupMessageStats(now);
    return written;
  }
}
