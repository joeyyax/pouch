import { pendingForwards, sendForward } from "@/lib/addresses/forward-send";
import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker:forward");

export interface ForwardLoopOptions {
  workerId?: string;
  intervalMs: number;
  batchSize: number;
}

/** Sends the forwards ingest queued. A forward goes through the send path like any message. */
export class ForwardLoop extends IntervalLoop<number> {
  protected readonly name = "forward";
  protected readonly feature = "addresses" as const;
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;

  constructor(private readonly options: ForwardLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<number> {
    const due = await pendingForwards(this.options.batchSize);
    for (const id of due) {
      if (this.stopped) break;
      await sendForward(id).catch((err) => log.error(`forward ${id} threw: ${safeErrorMessage(err)}`));
    }
    return due.length;
  }
}
