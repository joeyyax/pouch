import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per worker loop, written on every run (`lib/health/jobs.ts`). Service-wide, so no
 * organization. Postgres rather than Redis, which keeps nothing across a restart.
 */
export const jobHeartbeats = pgTable("job_heartbeats", {
  name: text("name").primaryKey(),
  /** The loop's own interval, so staleness is judged against its schedule. */
  intervalMs: integer("interval_ms").notNull(),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
  /** The last sign of life: a start, a finish, or a long run saying it's still going. */
  lastBeatAt: timestamp("last_beat_at", { withTimezone: true }).notNull().defaultNow(),
  /** Null after a clean run. A fixed sentence, never an error message. */
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  /** The worker that wrote the row last. */
  workerId: text("worker_id"),
});

export type JobHeartbeatRow = typeof jobHeartbeats.$inferSelect;
