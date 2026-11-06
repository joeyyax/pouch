/** Runs `convertToTenant` in the background, with its state on the row. */
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { providers } from "@/lib/db/schema";
import type { ActivityActor } from "@/lib/activity/types";
import { logger } from "@/lib/logger";
import { CONVERSION_JOB_KEY, CONVERSION_STALE_MS, conversionJobOf, type ConversionJobState } from "./conversion-state";
import { ConversionStoppedError, MissingPermissionsError, convertToTenant, planConversion, type ConversionPlan } from "./convert";
import { mergeSettings } from "./index";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("providers:convert-job");

const HEARTBEAT_MS = 30_000;

export interface StartedConversion {
  plan: ConversionPlan;
  /** False when a live run already holds the row. */
  started: boolean;
  /** Settles when the run does. Never rejects. */
  done: Promise<void>;
}

async function writeJob(providerId: string, job: ConversionJobState): Promise<void> {
  await mergeSettings(providerId, { [CONVERSION_JOB_KEY]: JSON.stringify(job) });
}

/** Claims the row unless a run with a fresh heartbeat holds it. */
async function claim(providerId: string, job: ConversionJobState): Promise<boolean> {
  const staleBefore = new Date(Date.now() - CONVERSION_STALE_MS).toISOString();
  const current = sql`(${providers.settings}->>${CONVERSION_JOB_KEY})::jsonb`;
  const claimed = await db
    .update(providers)
    .set({ settings: sql`${providers.settings} || ${JSON.stringify({ [CONVERSION_JOB_KEY]: JSON.stringify(job) })}::jsonb` })
    .where(
      sql`${providers.id} = ${providerId} and (
        ${providers.settings}->>${CONVERSION_JOB_KEY} is null
        or ${current}->>'state' <> 'running'
        or (${current}->>'heartbeat_at')::timestamptz < ${staleBefore}::timestamptz
      )`,
    )
    .returning({ id: providers.id });
  return claimed.length > 0;
}

/**
 * Validates the row, then converts it after the caller has returned. The plan's own checks throw
 * here, before anything starts; permission and provider failures land on the row's job state.
 */
export async function startConversion(providerId: string, actor: ActivityActor): Promise<StartedConversion> {
  const plan = await planConversion(providerId);
  const now = new Date().toISOString();
  const job: ConversionJobState = {
    state: "running",
    started_at: now,
    heartbeat_at: now,
    finished_at: null,
    reached: null,
    stopped_at: null,
    error: null,
  };
  if (plan.converted || !(await claim(providerId, job))) {
    return { plan, started: false, done: Promise.resolve() };
  }

  const done = (async () => {
    let reached: string | null = null;
    // Chained so the final write can't be overtaken by a heartbeat still in flight.
    let beating = Promise.resolve();
    const beat = setInterval(() => {
      beating = beating
        .then(() => writeJob(providerId, { ...job, reached, heartbeat_at: new Date().toISOString() }))
        .catch((err: Error) => log.warn(`conversion heartbeat for ${providerId} failed: ${safeErrorMessage(err)}`));
    }, HEARTBEAT_MS);
    const stop = async () => {
      clearInterval(beat);
      await beating;
    };
    try {
      const result = await convertToTenant(providerId, {
        actor,
        log: (line) => {
          const stage = /^(\w+): done$/.exec(line)?.[1];
          if (stage) reached = stage;
        },
      });
      await stop();
      const at = new Date().toISOString();
      await writeJob(providerId, { ...job, state: "done", reached: result.reached, heartbeat_at: at, finished_at: at });
    } catch (err) {
      await stop();
      const at = new Date().toISOString();
      const failed: ConversionJobState = {
        ...job,
        state: "failed",
        heartbeat_at: at,
        finished_at: at,
        reached: err instanceof ConversionStoppedError ? err.reached : reached,
        stopped_at: err instanceof ConversionStoppedError ? err.stage : null,
        error: safeErrorMessage(err),
        ...(err instanceof MissingPermissionsError ? { missing_permissions: err.missing } : {}),
      };
      log.warn(`conversion of ${providerId} failed: ${failed.error}`);
      await writeJob(providerId, failed).catch((writeErr: Error) => log.error(`recording the conversion failure for ${providerId} failed: ${safeErrorMessage(writeErr)}`));
    }
  })();

  return { plan, started: true, done };
}

/** The row's plan and its latest run, for a caller polling a conversion. */
export async function conversionStatus(providerId: string): Promise<{ plan: ConversionPlan; conversion: ReturnType<typeof conversionJobOf> }> {
  const plan = await planConversion(providerId);
  const [row] = await db.select({ settings: providers.settings }).from(providers).where(eq(providers.id, providerId)).limit(1);
  return { plan, conversion: row ? conversionJobOf(row) : null };
}
