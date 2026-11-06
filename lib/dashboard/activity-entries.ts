import { listActivity, type ActivityPage } from "@/lib/activity/query";
import type { ActivityCursor, ActivityFilters, ActivityListItem } from "@/lib/activity/types";
import { ACTIVITY_ENTRIES_PER_PAGE, activityEntriesByDay } from "@/lib/dashboard/views/activity-entries";

/** Rows read per round trip while filling a page. */
const BATCH = 100;

/** A run this long is split across pages rather than read to its end. */
const MAX_SCAN = 1000;

function entryCount(rows: ActivityListItem[], zone: string): number {
  return activityEntriesByDay(rows, zone).reduce((sum, day) => sum + day.groups.length, 0);
}

/** How many leading rows the first `entries` entries hold. */
function rowsInFirst(rows: ActivityListItem[], entries: number, zone: string): number {
  let taken = 0;
  let rowCount = 0;
  for (const day of activityEntriesByDay(rows, zone)) {
    for (const group of day.groups) {
      if (taken === entries) return rowCount;
      taken += 1;
      rowCount += group.count;
    }
  }
  return rowCount;
}

/**
 * A page of whole entries rather than raw rows, so collapsed runs don't leave it nearly empty.
 * Runs break at midnight in `zone`, the same days the screen draws.
 * Reads until the entry after the last one starts, which is what closes that last run. The cursor
 * is the last row kept, so a row lands on exactly one page.
 */
export async function listActivityEntries(
  organizationId: string,
  filters: ActivityFilters,
  zone: string,
  cursor: ActivityCursor | null = null,
  { entries = ACTIVITY_ENTRIES_PER_PAGE, batch = BATCH, maxScan = MAX_SCAN } = {},
): Promise<ActivityPage> {
  const rows: ActivityListItem[] = [];
  let next = cursor;
  let more = true;
  while (more) {
    const page = await listActivity(organizationId, filters, next, batch);
    rows.push(...page.rows);
    next = page.nextCursor;
    more = next !== null;
    if (entryCount(rows, zone) > entries || rows.length >= maxScan) break;
  }

  const kept = rows.slice(0, entryCount(rows, zone) > entries ? rowsInFirst(rows, entries, zone) : rows.length);
  const last = kept.at(-1);
  const cut = kept.length < rows.length || more;
  return { rows: kept, nextCursor: cut && last ? { createdAt: last.createdAt, id: last.id } : null };
}
