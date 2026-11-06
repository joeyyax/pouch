import { claimMessages, dueProviders, type ClaimedMessage } from "@/lib/messages/queue";
import { acquireSendPermits, refundSendPermits, sendRateSubject } from "@/lib/providers/send-rate";
import { deliver } from "./send";
import { logger } from "@/lib/logger";
import { JOB_ERROR, recordJobFinish, recordJobStart } from "@/lib/health";
import { reportError } from "@/lib/errors/report";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { runWithRequestId } from "@/lib/api/request-context";
import { reportTickFailure } from "@/lib/worker/tick-failure";

const log = logger.child("worker:loop");

export interface LoopOptions {
  workerId: string;
  /** Sends in flight across every provider. */
  maxConcurrency: number;
  pollIntervalMs: number;
}

/** Counts sends in flight per provider, so one provider can't take the whole worker. */
export class ConcurrencyTracker {
  private readonly inFlight = new Map<string, number>();

  start(providerId: string): void {
    this.inFlight.set(providerId, (this.inFlight.get(providerId) ?? 0) + 1);
  }

  finish(providerId: string): void {
    const next = (this.inFlight.get(providerId) ?? 1) - 1;
    if (next <= 0) this.inFlight.delete(providerId);
    else this.inFlight.set(providerId, next);
  }

  countFor(providerId: string): number {
    return this.inFlight.get(providerId) ?? 0;
  }

  total(): number {
    return [...this.inFlight.values()].reduce((sum, count) => sum + count, 0);
  }
}

/**
 * The backstop for a send that never settles. Every outbound call on the delivery path has its
 * own timeout, so this should never fire — it exists because when it does fire, the alternative
 * is invisible: an unsettled deliver() never releases its concurrency slot, and once every slot
 * is held the worker claims nothing while its heartbeat and /healthz both still read healthy.
 *
 * Past the deadline the slot is released and the underlying work is abandoned, not cancelled. It
 * stays safe because every write in deliver() goes through writeIfHeld, which lands only while
 * the worker still holds the row's lock — so a late finisher finds the lock stale and skips. The
 * deadline is under LOCK_TIMEOUT_MS for that reason: the slot must come back before another
 * worker can legitimately reclaim the row.
 */
const SLOT_DEADLINE_MS = 4 * 60 * 1000;

export function withSlotDeadline(
  work: Promise<void>,
  messageId: string,
  deadlineMs: number = SLOT_DEADLINE_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Guarded because the deadline and the work race: once one has settled the promise, the
    // other must not touch it. Calling reject() on a settled promise is a no-op, but building a
    // rejected promise to hand to resolve() is not — nothing adopts it, so it surfaces as an
    // unhandled rejection, which worker/index.ts turns into process.exit(1). Same shape as
    // lib/webhooks/deliver.ts.
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.error(`delivering ${messageId} passed ${deadlineMs}ms — releasing the slot, the send is abandoned`);
      resolve();
    }, deadlineMs);
    void work.then(
      () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        // A failure arriving after the deadline has no one left to tell: the slot is already
        // back and the caller's catch has moved on. Log it rather than reject into nothing.
        if (settled) {
          log.error(`delivering ${messageId} failed after its slot was released: ${safeErrorMessage(err)}`);
          return;
        }
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

const MIN_RATE_RETICK_MS = 10;

/** Fisher-Yates, so no tenant always claims first against a shared rate. */
export function shuffled<T>(items: T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export class SendLoop {
  private readonly tracker = new ConcurrencyTracker();
  private readonly running = new Set<Promise<void>>();
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private tickAgain = false;
  private rateTimer: NodeJS.Timeout | null = null;
  private rateTimerAt = 0;
  private cycle: Promise<void> | null = null;
  private inFlightTick: Promise<number> | null = null;
  /** The last round left due work behind for want of a slot. */
  private backlog = false;

  constructor(private readonly options: LoopOptions) {}

  /**
   * Claims and dispatches whatever the worker and each provider have room for.
   * Serialized: a tick arriving while one is running sets a flag instead of racing the capacity check.
   */
  async tick(): Promise<number> {
    if (this.ticking) {
      this.tickAgain = true;
      return 0;
    }
    this.ticking = true;
    try {
      this.inFlightTick = this.claimRound();
      return await this.inFlightTick;
    } finally {
      this.inFlightTick = null;
      this.ticking = false;
      if (this.tickAgain && !this.stopped) {
        this.tickAgain = false;
        void this.tick().catch((err: unknown) => {
          reportTickFailure(log, "send", err, this.options.workerId);
        });
      }
    }
  }

  private async claimRound(): Promise<number> {
    if (this.stopped) return 0;
    let room = this.options.maxConcurrency - this.tracker.total();
    if (room <= 0) {
      this.backlog = true;
      return 0;
    }

    let claimedCount = 0;
    let nextPermitMs: number | null = null;
    let backlog = false;

    for (const provider of shuffled(await dueProviders())) {
      if (room <= 0) {
        backlog = true;
        break;
      }
      const providerRoom = Math.min(room, provider.concurrency - this.tracker.countFor(provider.id));
      if (providerRoom <= 0) {
        backlog = true;
        continue;
      }

      const subject = sendRateSubject(provider);
      const { granted: limit, retryInMs } = await acquireSendPermits(subject, providerRoom);
      if (limit < providerRoom) nextPermitMs = Math.min(nextPermitMs ?? retryInMs, retryInMs);
      if (limit <= 0) continue;

      const claimed = await claimMessages({
        workerId: this.options.workerId,
        providerId: provider.id,
        limit,
      });
      await refundSendPermits(subject, limit - claimed.length);

      for (const item of claimed) this.dispatch(item);
      claimedCount += claimed.length;
      room -= claimed.length;
      // A full claim at the slot limit may have left rows; a rate-limited one has its own follow-up.
      if (claimed.length === providerRoom) backlog = true;
    }

    this.backlog = backlog;
    if (nextPermitMs !== null) this.retickWhenPermitted(nextPermitMs);
    return claimedCount;
  }

  /** A rate-limited round asks for its own follow-up once the next permit is due. */
  private retickWhenPermitted(delayMs: number): void {
    if (this.stopped) return;
    const at = Date.now() + Math.max(MIN_RATE_RETICK_MS, delayMs);
    if (this.rateTimer) {
      if (this.rateTimerAt <= at) return;
      clearTimeout(this.rateTimer);
    }
    this.rateTimerAt = at;
    this.rateTimer = setTimeout(() => {
      this.rateTimer = null;
      void this.tick().catch((err: unknown) => reportTickFailure(log, "send", err, this.options.workerId));
    }, at - Date.now());
    this.rateTimer.unref();
  }

  /** Fills a freed slot now rather than at the next poll. A round that finds nothing clears `backlog`, so this can't spin. */
  private tickForFreedSlot(): void {
    if (this.stopped) return;
    void this.tick().catch((err: unknown) => reportTickFailure(log, "send", err, this.options.workerId));
  }

  private dispatch(item: ClaimedMessage): void {
    this.tracker.start(item.provider.id);
    // The accepting request's id, so every line this send emits reads like the accept line did.
    const task = runWithRequestId(item.message.requestId, () =>
      withSlotDeadline(deliver(item, this.options.workerId), item.message.id)
        .catch((err: unknown) => {
          log.error(`delivering ${item.message.id} threw: ${safeErrorMessage(err)}`);
          reportError(err, {
            errorCode: "deliver_threw",
            messageId: item.message.id,
            workerId: this.options.workerId,
            providerId: item.provider.id,
            requestId: item.message.requestId ?? undefined,
          });
        })
        .finally(() => {
          this.tracker.finish(item.provider.id);
          this.running.delete(task);
          if (this.backlog) this.tickForFreedSlot();
        }),
    );
    this.running.add(task);
  }

  start(): void {
    const run = async () => {
      if (this.stopped) return;
      await recordJobStart("send", this.options.pollIntervalMs, this.options.workerId);
      let error: string | null = null;
      try {
        await this.tick();
      } catch (err) {
        reportTickFailure(log, "send", err, this.options.workerId);
        error = JOB_ERROR;
      }
      await recordJobFinish("send", error);
      if (this.stopped) return;
      if (!this.stopped) {
        this.timer = setTimeout(() => {
          this.cycle = run();
        }, this.options.pollIntervalMs);
      }
    };
    this.cycle = run();
  }

  /** Stops polling and waits for the round and sends in flight to settle. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.rateTimer) clearTimeout(this.rateTimer);
    await Promise.allSettled([this.cycle, this.inFlightTick]);
    await Promise.allSettled([...this.running]);
  }
}
