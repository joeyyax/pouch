/**
 * Activity log — retention. Server-only.
 *
 * Deletes rows past the window their action's class takes, under the operator's settings. An
 * action that declares none, and an action the taxonomy no longer knows, is never deleted.
 */
import { and, inArray, lt } from "drizzle-orm";
import { WORKER_DEFAULTS } from "@/lib/config";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { activity } from "@/lib/db/schema/activity";
import { readSettingValues } from "@/lib/settings/values";
import { retentionGroups } from "./taxonomy";
import type { RetentionWindows } from "./windows";

/** Per call, so one pass over a large backlog stays short; the next pass takes the rest. */
export const ACTIVITY_RETENTION_MAX_BATCHES = 50;

const DAY_MS = 86_400_000;

/** The windows the operator set, in days. */
export async function readRetentionWindows(): Promise<RetentionWindows> {
  const values = await readSettingValues();
  return { setup: values.activity_retention_days, churn: values.activity_churn_retention_days };
}

/** Returns how many rows went. `shouldStop` is checked between batches. */
export async function deleteExpiredActivity(
  batchSize: number = WORKER_DEFAULTS.WORKER_ACTIVITY_RETENTION_BATCH,
  shouldStop: () => boolean = () => false,
): Promise<number> {
  const [now, windows] = await Promise.all([dbNow(), readRetentionWindows()]);
  let deleted = 0;
  let batches = 0;

  for (const { days, actions } of retentionGroups(windows)) {
    const expired = and(inArray(activity.action, actions), lt(activity.createdAt, new Date(now.getTime() - days * DAY_MS)));
    for (;;) {
      if (shouldStop() || batches >= ACTIVITY_RETENTION_MAX_BATCHES) return deleted;
      const ids = db.select({ id: activity.id }).from(activity).where(expired).limit(batchSize);
      const gone = await db.delete(activity).where(inArray(activity.id, ids)).returning({ id: activity.id });
      batches += 1;
      deleted += gone.length;
      if (gone.length < batchSize) break;
    }
  }
  return deleted;
}
