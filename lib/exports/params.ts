/**
 * Export filters off a request's URL: the messages screen's own query string, parsed by the
 * screen's own reader (lib/messages/query.ts) and filtered by its own conditions
 * (lib/dashboard/message-volume.ts), so "export what you see" is the same query.
 */
import { listWindowStart } from "@/lib/dashboard/message-volume";
import { withFuzzySearch } from "@/lib/dashboard/messages";
import type { MessageFilters } from "@/lib/messages/filters";
import { readMessagesQuery } from "@/lib/messages/query";

/** The screen's filters with its window pinned to `now`, so a queued job exports the window the user saw. */
export function filtersFromSearchParams(params: URLSearchParams, now: Date = new Date()): MessageFilters {
  const { filters } = readMessagesQuery(Object.fromEntries(params));
  return { ...filters, since: listWindowStart(filters.since, now), screenWindow: true };
}

/**
 * Those filters plus the ids the screen's typo-tolerant search matched, resolved now and carried
 * with the job. An index that's down narrows to exact matches, as it does on the screen.
 */
export async function exportFiltersFromSearchParams(organizationId: string, params: URLSearchParams): Promise<MessageFilters> {
  return (await withFuzzySearch(organizationId, filtersFromSearchParams(params))).filters;
}
