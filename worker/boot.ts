import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker");

let bootError: Error | null = null;
let shuttingDown = false;
let booted = false;

/** True once the loop is wired and no boot error is outstanding. */
export function isReady(): boolean {
  return booted && !shuttingDown && bootError === null;
}

/** The last releaseStaleLocks failure, if any. Health uses this, not readiness. */
export function getBootError(): Error | null {
  return bootError;
}

/** Flips readiness once main has wired the subscriber and loop. */
export function markBooted(): void {
  booted = true;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms).unref();
  return promise;
}

/** Resolves true once the release lands, false when a shutdown interrupts the retries. */
export async function awaitBoot(release: () => Promise<number>): Promise<boolean> {
  let delayMs = 1000;
  for (;;) {
    try {
      await release();
      bootError = null;
      return true;
    } catch (err) {
      if (shuttingDown) return false;
      bootError = err as Error;
      log.warn(`releaseStaleLocks failed, retrying in ${delayMs}ms: ${safeErrorMessage(err)}`);
      await sleep(delayMs);
      if (shuttingDown) return false;
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }
}

/** Signals a shutdown so an in-flight boot retry stops instead of scheduling another. */
export function beginShutdown(): void {
  shuttingDown = true;
}

/** Clears the boot state. Tests only. */
export function resetBoot(): void {
  bootError = null;
  shuttingDown = false;
  booted = false;
}
