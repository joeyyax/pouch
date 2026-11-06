/** Cells for any range: the rollup where it covers, a live count of `messages` for the rest. */
import { and, eq, gte, inArray, lt, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageHourlyStats } from "@/lib/db/schema";
import { aggregateCells, ceilHour, createdBetween, floorHour, HOUR_MS, messageScope, type Cell, type StatsScope } from "./cells";
import { LIVE_HOURS, readRollupState, type RollupState } from "./rollup";

function cellScope(scope: StatsScope): SQL | undefined {
  return and(
    eq(messageHourlyStats.organizationId, scope.organizationId),
    scope.domainIds.length > 0 ? inArray(messageHourlyStats.domainId, scope.domainIds) : undefined,
    scope.domainId ? eq(messageHourlyStats.domainId, scope.domainId) : undefined,
    scope.apiKeyId ? eq(messageHourlyStats.apiKeyId, scope.apiKeyId) : undefined,
    scope.mode === "all" ? undefined : eq(messageHourlyStats.testMode, scope.mode === "test"),
  );
}

/** The whole hours of [since, until) the rollup answers. Empty when `from >= to`. */
export function rolledSpan(state: RollupState | null, since: Date, until: Date, now: Date): { from: Date; to: Date } {
  if (!state) return { from: until, to: until };
  const liveFrom = floorHour(new Date(now.getTime() - LIVE_HOURS * HOUR_MS));
  return {
    from: new Date(Math.max(ceilHour(since).getTime(), state.coveredFrom.getTime())),
    to: new Date(Math.min(floorHour(until).getTime(), liveFrom.getTime(), state.coveredUntil.getTime())),
  };
}

async function live(scope: StatsScope, since: Date, until: Date): Promise<Cell[]> {
  if (since >= until) return [];
  return aggregateCells(and(messageScope(scope), createdBetween(since, until)));
}

/**
 * Messages created in [since, until), one cell per hour, domain, key and mode. The rollup answers
 * whole hours older than the live day that it covers; the partial hour at `since`, the last day and
 * anything the rollup hasn't reached are counted live.
 */
export async function readCells(scope: StatsScope, since: Date, until: Date, now: Date): Promise<Cell[]> {
  const { from, to } = rolledSpan(await readRollupState(), since, until, now);
  if (from >= to) return live(scope, since, until);

  const [stored, head, tail] = await Promise.all([
    db
      .select()
      .from(messageHourlyStats)
      .where(and(cellScope(scope), gte(messageHourlyStats.hour, from), lt(messageHourlyStats.hour, to))),
    live(scope, since, from),
    live(scope, to, until),
  ]);
  return [...head, ...stored, ...tail];
}
