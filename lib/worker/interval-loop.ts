import { JOB_ERROR, recordJobFinish, recordJobStart } from "@/lib/health";
import type { LoopName } from "@/lib/health/names";
import { isFeatureEnabled, type Feature } from "@/lib/features";
import type { Logger } from "@/lib/logger";
import { reportTickFailure } from "./tick-failure";

/**
 * A loop that wakes on an interval, does one pass, and reports it happened.
 *
 * Eleven loops hand-rolled this. Four never reported a heartbeat at all, so a dead stall guard
 * looked exactly like a healthy one; four others had returned from `stop()` without awaiting
 * in-flight work until the change before this one fixed them one by one. Neither gap was
 * decided — both accumulated, because every loop had to remember. Owning start, stop, the guard
 * and the heartbeat here makes them structural instead: a loop gets them by existing.
 *
 * A subclass supplies `name`, `log`, `intervalMs` and `run()`. `SendLoop` deliberately doesn't
 * extend this — it tracks a set of in-flight sends rather than one in-flight tick, and folding
 * that in would mean options only one subclass ever uses.
 */
export abstract class IntervalLoop<T> {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<T> | null = null;

  /** Read by long passes so a sweep mid-batch stops at the next row instead of finishing it. */
  protected stopped = false;

  /** Must be in `LOOP_NAMES`, which is what puts the loop on the admin system screen. */
  protected abstract readonly name: LoopName;
  protected abstract readonly log: Logger;
  protected abstract readonly intervalMs: number;

  /** Set where a loop knows which worker it belongs to; the heartbeat records it per worker. */
  protected readonly workerId: string | undefined = undefined;

  /** The feature this loop works for. While it's off, a scheduled pass does nothing and still beats. */
  protected readonly feature: Feature | null = null;

  /** One pass. Never called concurrently with itself — `tick()` guarantees that. */
  protected abstract run(): Promise<T>;

  /**
   * One pass, or the pass already running. Returning the in-flight promise rather than queueing
   * another means a nudge arriving mid-pass joins it instead of stacking a second sweep over the
   * same rows.
   */
  async tick(): Promise<T> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** The scheduled pass: `tick()`, or nothing while the loop's feature is off. */
  async pass(): Promise<T | undefined> {
    if (this.feature && !(await isFeatureEnabled(this.feature))) return undefined;
    return this.tick();
  }

  start(): void {
    const cycle = async (): Promise<void> => {
      if (this.stopped) return;
      await recordJobStart(this.name, this.intervalMs, this.workerId ?? "unknown");
      let error: string | null = null;
      try {
        await this.pass();
      } catch (err) {
        reportTickFailure(this.log, this.name, err, this.workerId);
        error = JOB_ERROR;
      }
      // After the pass, with its outcome: a run that threw is recorded as failing, not alive.
      await recordJobFinish(this.name, error);
      if (!this.stopped) this.timer = setTimeout(() => void cycle(), this.intervalMs);
    };
    void cycle();
  }

  /** Stops the timer and waits for the pass in flight, so a shutdown can't cut one mid-write. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight?.catch(() => undefined);
  }
}
