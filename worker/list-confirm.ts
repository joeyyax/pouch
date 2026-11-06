/**
 * Sends double opt-in confirmation emails (#7). Every path that can create a pending
 * membership — `subscribe` on a send, `POST /v1/lists/:id/members`, a CSV import, a manual add
 * — only ever writes the row; this loop is the one place that turns a pending, unconfirmed
 * membership into an actual email, so no caller can forget to send it and no caller waits on
 * the send.
 */
import { pendingConfirmations, sendConfirmation } from "@/lib/lists/opt-in";
import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { reportError } from "@/lib/errors/report";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker:list-confirm");

export interface ListConfirmLoopOptions {
  workerId: string;
  intervalMs: number;
  batchSize: number;
}

export class ListConfirmLoop extends IntervalLoop<number> {
  protected readonly name = "list";
  protected readonly feature = "lists" as const;
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;

  constructor(private readonly options: ListConfirmLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<number> {
    const due = await pendingConfirmations(this.options.batchSize);
    let sent = 0;
    let failed = 0;
    let lastError: unknown = null;

    for (const membership of due) {
      if (this.stopped) break;
      // sendConfirmation documents itself as never throwing, but its context read and its final
      // write sit outside its own try. One row that throws would abort the pass and take the
      // other 49 in the batch with it.
      try {
        await sendConfirmation(membership.id);
        sent++;
      } catch (err) {
        failed++;
        lastError = err;
        log.error(`sending confirmation for membership ${membership.id} threw: ${safeErrorMessage(err)}`);
      }
    }

    // Per-row catching is right, but on its own it turns "every confirmation is failing" into a
    // handful of log lines and a tick that looks idle. A pass where nothing succeeded is a
    // configuration problem, not a bad row, and it gets reported as one.
    if (failed > 0 && sent === 0) {
      reportError(lastError, { errorCode: "list_confirm_all_failed", workerId: this.workerId });
      log.error(`every confirmation in this pass failed (${failed} of ${failed})`);
    }

    return sent;
  }

}
