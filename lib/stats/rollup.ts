/**
 * Writes `message_hourly_stats`: each hour once it leaves the live day, then again whenever one of
 * its messages changes. Reads take everything after `covered_until` live.
 */
import { and, eq, gte, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { messageHourlyStats, messageStatsRollup, messages } from "@/lib/db/schema";
import { aggregateCells, floorHour, hourStartOf, HOUR_MS } from "./cells";

/** Hours younger than this are always read live. */
export const LIVE_HOURS = 24;
/** Covers a 90-day window and the one before it. */
export const ROLLUP_KEPT_DAYS = 190;
/** A message updated in a transaction that began before the last run still gets picked up. */
export const OVERLAP_MS = 5 * 60_000;
/** Ranges per statement. */
const CHUNK = 100;
const LOCK_KEY = 0x5354_4154;

export interface RollupState {
  coveredFrom: Date;
  coveredUntil: Date;
  ranAt: Date;
}

export async function readRollupState(executor: Executor = db): Promise<RollupState | null> {
  const [row] = await executor.select().from(messageStatsRollup).limit(1);
  return row ? { coveredFrom: row.coveredFrom, coveredUntil: row.coveredUntil, ranAt: row.ranAt } : null;
}

/** Hours `[from, to)` of one organization, or of the service's own mail when null, to recompute. */
interface HourRange {
  organizationId: string | null;
  from: Date;
  to: Date;
}

/** Folds an organization's hours into contiguous ranges. */
function toRanges(hours: { organizationId: string | null; hour: number }[]): HourRange[] {
  const byOrganization = new Map<string | null, number[]>();
  for (const { organizationId, hour } of hours) {
    const list = byOrganization.get(organizationId) ?? [];
    list.push(hour);
    byOrganization.set(organizationId, list);
  }
  const ranges: HourRange[] = [];
  for (const [organizationId, list] of byOrganization) {
    const sorted = [...new Set(list)].sort((a, b) => a - b);
    let start = sorted[0]!;
    let end = start + HOUR_MS;
    for (const at of sorted.slice(1)) {
      if (at === end) {
        end += HOUR_MS;
        continue;
      }
      ranges.push({ organizationId, from: new Date(start), to: new Date(end) });
      start = at;
      end = at + HOUR_MS;
    }
    ranges.push({ organizationId, from: new Date(start), to: new Date(end) });
  }
  return ranges;
}

const createdHour = hourStartOf(messages.createdAt);

async function hoursWith(executor: Executor, where: SQL | undefined): Promise<{ organizationId: string | null; hour: number }[]> {
  return executor
    .selectDistinct({ organizationId: messages.organizationId, hour: createdHour })
    .from(messages)
    .where(where);
}

async function rewrite(executor: Executor, ranges: HourRange[]): Promise<number> {
  let written = 0;
  for (let start = 0; start < ranges.length; start += CHUNK) {
    const chunk = ranges.slice(start, start + CHUNK);
    await executor
      .delete(messageHourlyStats)
      .where(
        or(
          ...chunk.map((range) =>
            and(
              range.organizationId === null ? isNull(messageHourlyStats.organizationId) : eq(messageHourlyStats.organizationId, range.organizationId),
              gte(messageHourlyStats.hour, range.from),
              lt(messageHourlyStats.hour, range.to),
            ),
          ),
        ),
      );
    const cells = await aggregateCells(
      or(
        ...chunk.map((range) =>
          and(
            range.organizationId === null ? isNull(messages.organizationId) : eq(messages.organizationId, range.organizationId),
            gte(messages.createdAt, range.from),
            lt(messages.createdAt, range.to),
          ),
        ),
      ),
      executor,
    );
    for (let at = 0; at < cells.length; at += 500) {
      await executor.insert(messageHourlyStats).values(cells.slice(at, at + 500));
    }
    written += cells.length;
  }
  return written;
}

/**
 * One run, ending at `now`. The first run fills every kept hour; later ones add the hours that
 * left the live day and redo hours with a message updated since the last run. Returns cells written.
 */
export async function rollupMessageStats(now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(${LOCK_KEY}) as locked`);
    if (!lock?.locked) return 0;

    const state = await readRollupState(tx);
    const cutoff = floorHour(new Date(now.getTime() - ROLLUP_KEPT_DAYS * 24 * HOUR_MS));
    const until = new Date(Math.max(floorHour(new Date(now.getTime() - LIVE_HOURS * HOUR_MS)).getTime(), state?.coveredUntil.getTime() ?? 0));
    const coveredFrom = new Date(Math.max(cutoff.getTime(), state?.coveredFrom.getTime() ?? 0));

    let ranges: HourRange[];
    if (!state) {
      ranges = toRanges(await hoursWith(tx, and(gte(messages.createdAt, cutoff), lt(messages.createdAt, until))));
    } else {
      const entering = await hoursWith(tx, and(gte(messages.createdAt, state.coveredUntil), lt(messages.createdAt, until)));
      // An hour that just left the live day may hold rows from before a crash; clear the whole span.
      await tx.delete(messageHourlyStats).where(and(gte(messageHourlyStats.hour, state.coveredUntil), lt(messageHourlyStats.hour, until)));
      const changed = await hoursWith(
        tx,
        and(
          gte(messages.updatedAt, new Date(state.ranAt.getTime() - OVERLAP_MS)),
          gte(messages.createdAt, coveredFrom),
          lt(messages.createdAt, state.coveredUntil),
        ),
      );
      ranges = toRanges([...entering, ...changed]);
    }

    const written = await rewrite(tx, ranges);
    await tx.delete(messageHourlyStats).where(lt(messageHourlyStats.hour, cutoff));
    await tx
      .insert(messageStatsRollup)
      .values({ id: "rollup", coveredFrom: state ? coveredFrom : cutoff, coveredUntil: until, ranAt: now })
      .onConflictDoUpdate({ target: messageStatsRollup.id, set: { coveredFrom, coveredUntil: until, ranAt: now } });
    return written;
  });
}
