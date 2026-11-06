import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { messageEvents, messages } from "@/lib/db/schema";
import { recordActivity, workerActor } from "@/lib/activity/record";
import { ABANDON_MS } from "@/lib/metrics/conditions";
import { newId } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { checkUnconfirmedCluster } from "@/lib/messages/unconfirmed-alert";
import type { OccurrenceDetail } from "@/lib/messages/events";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker:abandon");

/** How often a pass re-reads the cluster window. The window is a day wide, so a minute buys nothing. */
export const UNCONFIRMED_CHECK_INTERVAL_MS = 5 * 60_000;

export interface AbandonLoopOptions {
  /** Which worker this loop belongs to. The heartbeat is per worker, so replicas must differ. */
  workerId?: string;
  /** How often the loop wakes up. */
  intervalMs: number;
  /** Messages marked per pass. */
  batchSize: number;
}

/**
 * Marks `sent` messages whose delivery confirmation never arrived.
 *
 * Finds every message still `status = 'sent'` with `sent_at` older than ABANDON_MS and no
 * `abandoned_at` yet, stamps `abandoned_at`, and writes a `message_events` row saying no
 * confirmation came. It's not a failure — the mail most likely landed. `status` doesn't change
 * — the row is still `sent`, marked. That
 * keeps the API, webhooks and the rest of the lifecycle untouched; only the dashboard's own
 * reads (lib/dashboard/metrics.ts, the message detail) know to treat a marked row differently.
 *
 * Also pushes when the marks cross into clustered — one mark is a provider gap, a cluster is our
 * own event ingest dropping them (lib/messages/unconfirmed-alert.ts).
 */
export class AbandonLoop extends IntervalLoop<{ marked: number }> {
  protected readonly name = "abandon";
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;
  private lastClusterCheckAt = 0;

  constructor(private readonly options: AbandonLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<{ marked: number }> {
    const now = await dbNow();
    const marked = await this.sweep(now);
    await this.checkCluster(now);
    return { marked };
  }

  private async sweep(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - ABANDON_MS);

    // A batch of candidate ids first, same as the retention sweep: a giant backlog can't pin
    // the worker, and a row that gets a terminal event mid-sweep just won't match the update
    // below anymore.
    const due = await db
      .select({ id: messages.id, organizationId: messages.organizationId })
      .from(messages)
      .where(and(eq(messages.status, "sent"), isNull(messages.abandonedAt), lt(messages.sentAt, cutoff)))
      .orderBy(messages.sentAt)
      .limit(this.options.batchSize);

    if (due.length === 0) return 0;

    const marked = await db
      .update(messages)
      .set({ abandonedAt: now, updatedAt: now })
      .where(
        and(
          eq(messages.status, "sent"),
          isNull(messages.abandonedAt),
          inArray(
            messages.id,
            due.map((row) => row.id),
          ),
        ),
      )
      .returning({ id: messages.id, organizationId: messages.organizationId });

    if (marked.length === 0) return 0;

    await db.insert(messageEvents).values(
      marked.map((row) => ({
        id: newId("event"),
        organizationId: row.organizationId,
        messageId: row.id,
        kind: "abandoned" as const,
        status: null,
        detail: { thresholdMs: ABANDON_MS } satisfies OccurrenceDetail["abandoned"],
        occurredAt: now,
      })),
    );

    // The service's own mail records on the service's activity, under a null organization.
    const byOrg = new Map<string | null, number>();
    for (const row of marked) byOrg.set(row.organizationId, (byOrg.get(row.organizationId) ?? 0) + 1);
    await Promise.all(
      [...byOrg.entries()].map(([organizationId, count]) =>
        recordActivity({
          organizationId,
          action: "system.abandon.swept",
          actor: workerActor("Abandon sweep"),
          metadata: { count },
        }),
      ),
    );

    log.info(`marked ${marked.length} message(s) abandoned`);
    return marked.length;
  }

  /**
   * Pushes when the window crosses into clustered. It belongs here because this is the loop that
   * does the marking — a pass runs the check only when the sweep is running, and only when the
   * previous pass's heartbeat says so, since a cluster is worth nothing from a loop that's down.
   * Runs on its own cadence, not once a pass, and regardless of what this pass marked: a cluster
   * from earlier in the window stands even when there's nothing left to mark right now.
   */
  private async checkCluster(now: Date): Promise<void> {
    if (this.stopped) return;
    if (now.getTime() - this.lastClusterCheckAt < UNCONFIRMED_CHECK_INTERVAL_MS) return;
    this.lastClusterCheckAt = now.getTime();
    await checkUnconfirmedCluster().catch((err: unknown) => {
      log.warn(`the unconfirmed cluster check threw: ${safeErrorMessage(err)}`);
    });
  }
}
