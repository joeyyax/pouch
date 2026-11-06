import { parseCursor, parseFilters, type RawParams } from "@/lib/activity/filter";
import type { ActivityCursor, ActivityFilters } from "@/lib/activity/types";

export type SearchParams = RawParams;

export interface ActivityQuery {
  filters: ActivityFilters;
  cursor: ActivityCursor | null;
  /** Whether this page is reached by paging back from a newer one. */
  paged: boolean;
  narrowed: boolean;
}

export function readActivityQuery(params: SearchParams): ActivityQuery {
  const filters = parseFilters(params);
  const cursor = parseCursor(params);
  return {
    filters,
    cursor,
    paged: cursor !== null,
    narrowed: filters.families.length > 0 || filters.outcomes.length > 0 || filters.actors.length > 0 || filters.since !== null,
  };
}
