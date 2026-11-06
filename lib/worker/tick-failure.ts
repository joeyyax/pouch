import { reportError } from "@/lib/errors/report";
import type { Logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

/**
 * What a loop does when its tick throws: log it, and report it.
 *
 * Reporting is the part that was missing. The worker runs unattended, so only its crash path
 * reported anything — a loop that threw on every tick, from a migration mismatch or one bad row,
 * wrote a log line nobody was watching and raised nothing. The process stayed up, so the crash
 * handler never fired.
 *
 * `errorCode` is `loop:<name>`, which becomes the `error_code` tag, so one failing loop groups on
 * its own rather than merging with every other loop that happens to throw the same message.
 *
 * `reportError` caps a repeated fingerprint at 20 a minute — a ceiling, not silence, and a loop
 * ticking every two seconds sits at that ceiling for as long as it stays broken. A fingerprint
 * carrying variable text (a message id, a Postgres row detail) is a fresh key every time and
 * never reaches the cap at all. Both are #269.
 */
export function reportTickFailure(log: Logger, loop: string, err: unknown, workerId?: string): void {
  log.error(`tick failed: ${safeErrorMessage(err)}`);
  reportError(err, { errorCode: `loop:${loop}`, ...(workerId === undefined ? {} : { workerId }) });
}
