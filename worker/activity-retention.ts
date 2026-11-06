import { deleteExpiredActivity } from "@/lib/activity/retention";
import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";

const log = logger.child("worker:activity-retention");

export interface ActivityRetentionLoopOptions {
  workerId?: string;
  intervalMs: number;
  batchSize: number;
}

/** Deletes activity rows past the retention their action declares. */
export class ActivityRetentionLoop extends IntervalLoop<{ deleted: number }> {
  protected readonly name = "activity-retention";
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;

  constructor(private readonly options: ActivityRetentionLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<{ deleted: number }> {
    const deleted = await deleteExpiredActivity(this.options.batchSize, () => this.stopped);
    if (deleted > 0) log.info(`deleted ${deleted} activity row(s) past retention`);
    return { deleted };
  }
}
