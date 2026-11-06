import { dbNow } from "@/lib/db/clock";
import { logger } from "@/lib/logger";
import { currentWindow, dueCadences } from "@/lib/mail/digest/cadence";
import { runDigest } from "@/lib/mail/digest/send";
import { SystemMailNotConfiguredError } from "@/lib/mail/system";
import { readSetting } from "@/lib/settings/values";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker:digest");

export interface DigestLoopOptions {
  workerId?: string;
  intervalMs: number;
}

/**
 * Sends the daily, weekly and monthly digests. Rides its own slow loop rather than another
 * one — retention and provider-health already tick on their own unrelated cadences, and a
 * digest sharing one of those would couple its timing to a batch size or a probe interval
 * that has nothing to do with when a digest is actually due.
 */
export class DigestLoop extends IntervalLoop<number> {
  protected readonly name = "digest";
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;

  constructor(private readonly options: DigestLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<number> {
    const now = await dbNow();
    const due = dueCadences(now, await readSetting("digest_hour"));
    let sent = 0;

    for (const cadence of due) {
      if (this.stopped) break;
      const window = currentWindow(cadence, now);
      try {
        const count = await runDigest(window);
        sent += count;
        if (count > 0) log.info(`${cadence} digest for ${window.windowKey}: sent ${count}`);
      } catch (err) {
        if (err instanceof SystemMailNotConfiguredError) {
          log.warn(`${cadence} digest skipped: ${safeErrorMessage(err)}`);
          continue;
        }
        log.error(`${cadence} digest for ${window.windowKey} failed: ${safeErrorMessage(err)}`);
      }
    }

    return sent;
  }

}
