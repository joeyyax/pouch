/**
 * Job heartbeats, in Postgres: Redis keeps nothing across a restart, so a loop that runs hourly
 * read "never reported" for up to an hour after one. Every run records its start and finish;
 * the system screen and `/healthz?detail` read them back as stale, failing or never run.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { jobHeartbeats, type JobHeartbeatRow } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { LOOP_NAMES, type LoopName } from "./names";
import type { JobState } from "@/lib/system/views";
import { safeErrorMessage } from "@/lib/errors/scrub";

export { LOOP_NAMES, type LoopName } from "./names";

const log = logger.child("health:jobs");

/** Missed runs tolerated before a job reads stale. */
const MISSED_RUNS_ALLOWED = 3;
/** Floor under a fast job's window, so a couple of seconds' jitter isn't an alarm. */
const MIN_STALE_WINDOW_MS = 15_000;

/** How long a job may go without a sign of life before it's stale rather than late. */
export function staleWindowMs(intervalMs: number): number {
  return Math.max(intervalMs * MISSED_RUNS_ALLOWED, MIN_STALE_WINDOW_MS);
}

/** Stale past its own window, failing when the last run threw, never with no row at all. */
export function jobState(row: Pick<JobHeartbeatRow, "intervalMs" | "lastBeatAt" | "lastError"> | null, now: Date): JobState {
  if (!row) return "never";
  if (now.getTime() - row.lastBeatAt.getTime() > staleWindowMs(row.intervalMs)) return "stale";
  return row.lastError ? "failing" : "ok";
}

export const JOB_ERROR = "The last run threw. The log and error reporting have the details.";

/** Never throws: a job that can't record its heartbeat should keep running. */
export async function recordJobStart(name: LoopName, intervalMs: number, workerId: string): Promise<void> {
  try {
    await db
      .insert(jobHeartbeats)
      .values({ name, intervalMs, workerId, lastStartedAt: sql`now()` })
      .onConflictDoUpdate({
        target: jobHeartbeats.name,
        set: { intervalMs, workerId, lastStartedAt: sql`now()`, lastBeatAt: sql`now()` },
      });
  } catch (err) {
    log.warn(`recording the start of ${name} failed: ${safeErrorMessage(err)}`);
  }
}

/** `error` is a fixed sentence, never an error message. Null records a clean run. */
export async function recordJobFinish(name: LoopName, error: string | null): Promise<void> {
  try {
    await db
      .update(jobHeartbeats)
      .set({
        lastFinishedAt: sql`now()`,
        lastBeatAt: sql`now()`,
        lastError: error,
        consecutiveFailures: error ? sql`${jobHeartbeats.consecutiveFailures} + 1` : 0,
      })
      .where(eq(jobHeartbeats.name, name));
  } catch (err) {
    log.warn(`recording the finish of ${name} failed: ${safeErrorMessage(err)}`);
  }
}

/** A run that outlasts its window, an export building for minutes, says it's still going. */
export async function recordJobBeat(name: LoopName): Promise<void> {
  try {
    await db.update(jobHeartbeats).set({ lastBeatAt: sql`now()` }).where(eq(jobHeartbeats.name, name));
  } catch (err) {
    log.warn(`recording a beat for ${name} failed: ${safeErrorMessage(err)}`);
  }
}

export interface JobReading {
  name: LoopName;
  state: JobState;
  row: JobHeartbeatRow | null;
}

/** Every loop the worker runs, a never-run one included, in `LOOP_NAMES` order. */
export async function readJobs(): Promise<JobReading[]> {
  const [rows, now] = await Promise.all([db.select().from(jobHeartbeats), dbNow()]);
  const byName = new Map(rows.map((row) => [row.name, row]));
  return LOOP_NAMES.map((name) => {
    const row = byName.get(name) ?? null;
    return { name, state: jobState(row, now), row };
  });
}
