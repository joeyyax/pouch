import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { DEFAULT_BODY_RETENTION_DAYS, retentionCeiling } from "@/lib/organizations";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { messageEvents, messages, organizations } from "@/lib/db/schema";
import { recordActivity, workerActor } from "@/lib/activity/record";
import { purgeExpiredReports } from "@/lib/dmarc/retention";
import { newId } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";

const log = logger.child("worker:retention");

export interface RetentionLoopOptions {
  /** Defaults for a single-loop test harness that has no worker process around it. */
  workerId?: string;
  /** How often the loop wakes up. */
  intervalMs: number;
  /** Messages shredded per pass. */
  batchSize: number;
}

/**
 * Shreds the body keys of messages past their organization's retention window.
 *
 * Per organization, finds every message with a non-null body_key and a created_at older than
 * `now - body_retention_days`, then nulls body_key and stamps body_purged_at. A null key
 * means the body can no longer be decrypted; the dashboard and worker treat that row as
 * unreadable. The objects in storage can be collected by a single lifecycle rule above the
 * maximum retention, since they're inert without the key.
 */
export class RetentionLoop extends IntervalLoop<{ shredded: number; orgs: number }> {
  protected readonly name = "retention";
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;

  constructor(private readonly options: RetentionLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  /**
   * A message that held a credential keeps its body only until the worker has read it to send.
   * Past `queued` the key goes, whatever the organization's retention window says.
   */
  private async shredWithheld(now: Date): Promise<number> {
    const shredded = await db
      .update(messages)
      .set({ bodyKey: null, bodyPurgedAt: sql`coalesce(${messages.bodyPurgedAt}, now())`, updatedAt: now })
      .where(and(isNotNull(messages.bodyWithheld), isNotNull(messages.bodyKey), ne(messages.status, "queued")))
      .returning({ id: messages.id, organizationId: messages.organizationId });
    if (shredded.length > 0) {
      await db.insert(messageEvents).values(
        shredded.map((row) => ({
          id: newId("event"),
          organizationId: row.organizationId,
          messageId: row.id,
          kind: "body_shredded" as const,
          status: null,
          detail: { retentionDays: null },
          occurredAt: now,
        })),
      );
    }
    return shredded.length;
  }

  protected async run(): Promise<{ shredded: number; orgs: number }> {
    const now = await dbNow();
    const ceiling = await retentionCeiling();
    const orgs: { id: string | null; bodyRetentionDays: number }[] = (
      await db.select({ id: organizations.id, bodyRetentionDays: organizations.bodyRetentionDays }).from(organizations)
    ).map((org) => ({ ...org, bodyRetentionDays: Math.min(org.bodyRetentionDays, ceiling) }));
    // The service's own mail, under no organization.
    orgs.push({ id: null, bodyRetentionDays: Math.min(DEFAULT_BODY_RETENTION_DAYS, ceiling) });

    let totalShredded = 0;
    let totalOrgs = 0;

    for (const org of orgs) {
      if (this.stopped) break;
      const cutoff = new Date(now.getTime() - org.bodyRetentionDays * 24 * 60 * 60 * 1000);
      const held = org.id === null ? isNull(messages.organizationId) : eq(messages.organizationId, org.id);

      // Pull a batch of candidate ids so a giant backlog can't pin the worker, and so a row
      // that gets claimed mid-sweep still gets the rest of its lifecycle written normally.
      const due = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            held,
            isNotNull(messages.bodyKey),
            lt(messages.createdAt, cutoff),
          ),
        )
        .orderBy(messages.createdAt)
        .limit(this.options.batchSize);

      if (due.length === 0) continue;
      totalOrgs += 1;

      const shredded = await db
        .update(messages)
        .set({ bodyKey: null, bodyPurgedAt: sql`coalesce(${messages.bodyPurgedAt}, now())`, updatedAt: now })
        .where(and(held, inArray(messages.id, due.map((row) => row.id)), isNotNull(messages.bodyKey)))
        .returning({ id: messages.id });

      totalShredded += shredded.length;

      if (shredded.length > 0) {
        await db.insert(messageEvents).values(
          shredded.map((row) => ({
            id: newId("event"),
            organizationId: org.id,
            messageId: row.id,
            kind: "body_shredded" as const,
            status: null,
            detail: { retentionDays: org.bodyRetentionDays },
            occurredAt: now,
          })),
        );
        await recordActivity({
          organizationId: org.id,
          action: "system.retention.swept",
          actor: workerActor("Retention sweep"),
          metadata: { count: shredded.length },
        });
      }
    }

    totalShredded += await this.shredWithheld(now);

    const reports = await purgeExpiredReports(now, this.options.batchSize);
    if (reports > 0) log.info(`deleted ${reports} DMARC report(s) past retention`);

    if (totalShredded > 0) {
      log.info(`shredded ${totalShredded} body key(s) across ${totalOrgs} organization(s)`);
    }
    return { shredded: totalShredded, orgs: totalOrgs };
  }

}
