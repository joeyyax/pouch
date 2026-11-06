import { and, asc, inArray, lt, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { inboundMessages } from "@/lib/db/schema";
import { purgeInboundObjects } from "@/lib/inbound/attachments";
import { scrubInboundPayloads } from "@/lib/inbound/payloads";
import { logger } from "@/lib/logger";
import { readSetting } from "@/lib/settings/values";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker:inbound-retention");

const DAY_MS = 86_400_000;

export interface InboundRetentionLoopOptions {
  workerId?: string;
  intervalMs: number;
  batchSize: number;
}

/** Purges inbound mail past retention, its own or the install's ceiling: objects, then webhook payload bodies and the row with its key. */
export class InboundRetentionLoop extends IntervalLoop<{ purged: number }> {
  protected readonly name = "inbound-retention";
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;

  constructor(private readonly options: InboundRetentionLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<{ purged: number }> {
    const [now, ceiling] = await Promise.all([dbNow(), readSetting("inbound_retention_max_days")]);
    const expired = or(lt(inboundMessages.expiresAt, now), lt(inboundMessages.receivedAt, new Date(now.getTime() - ceiling * DAY_MS)))!;
    let purged = 0;

    for (;;) {
      if (this.stopped) break;

      const due = await db
        .select()
        .from(inboundMessages)
        .where(expired)
        .orderBy(asc(inboundMessages.expiresAt))
        .limit(this.options.batchSize);

      if (due.length === 0) break;

      // Attachments are removed before the row: if the process dies in between, the next pass
      // still finds the row and retries the object deletes — a row surviving with dangling
      // objects is recoverable, an object surviving with no row pointing at it isn't. Only a row
      // whose attachments actually purged goes into the delete below — one that failed (a
      // transient storage outage, say) stays put and is retried next tick rather than dropped
      // with its objects still sitting in the bucket.
      const outcomes = await Promise.allSettled(due.map((row) => purgeInboundObjects(row)));
      const purgeable: string[] = [];
      let failures = 0;
      outcomes.forEach((outcome, index) => {
        const row = due[index]!;
        if (outcome.status === "fulfilled") {
          purgeable.push(row.id);
        } else {
          failures += 1;
          log.warn(`purging attachments for inbound message ${row.id} failed, leaving it for the next pass: ${safeErrorMessage(outcome.reason)}`);
        }
      });

      if (purgeable.length > 0) {
        const rows = due.filter((row) => purgeable.includes(row.id));
        const deleted = await db.transaction(async (tx) => {
          await scrubInboundPayloads(tx, rows);
          return tx
            .delete(inboundMessages)
            .where(and(inArray(inboundMessages.id, purgeable), expired))
            .returning({ id: inboundMessages.id });
        });
        purged += deleted.length;
      }

      // A failure this pass means storage is likely still unhappy — stop for this tick rather
      // than immediately re-querying the same row and spinning on it. The next tick retries.
      if (failures > 0) break;
      if (due.length < this.options.batchSize) break;
    }

    if (purged > 0) log.info(`purged ${purged} inbound message(s) past retention`);
    return { purged };
  }

}
