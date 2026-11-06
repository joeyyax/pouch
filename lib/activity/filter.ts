/**
 * Activity log — filters.
 *
 * Parses and serializes filter state, which lives in the URL so a view can be linked and a
 * refresh doesn't lose it. Narrowing itself happens in SQL (see query.ts).
 */
import { isFamily, isOutcome } from "./taxonomy";
import type { ActivityActor, ActivityCursor, ActivityFamily, ActivityFilters, ActivityOutcome } from "./types";

type Raw = string | string[] | null | undefined;

function readList(value: Raw): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function parseFamilies(raw: Raw): ActivityFamily[] {
  return unique(readList(raw).map((v) => v.toLowerCase()).filter(isFamily));
}

function parseOutcomes(raw: Raw): ActivityOutcome[] {
  return unique(readList(raw).map((v) => v.toLowerCase()).filter(isOutcome));
}

function parseActors(raw: Raw): string[] {
  return unique(readList(raw));
}

/** Rejects a future timestamp and unparseable input, rather than guessing at one. */
function parseSince(raw: Raw, now: Date = new Date()): Date | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const parsed = new Date(value);
  const time = parsed.getTime();
  if (Number.isNaN(time) || time > now.getTime()) return null;
  return parsed;
}

export type RawParams = Record<string, string | string[] | undefined>;

export function parseFilters(params: RawParams, now: Date = new Date()): ActivityFilters {
  return {
    families: parseFamilies(params.family),
    outcomes: parseOutcomes(params.outcome),
    actors: parseActors(params.actor),
    since: parseSince(params.since, now),
  };
}

/** The `before`/`beforeId` pair every activity list pages by, or null at the newest page. */
export function parseCursor(params: RawParams): ActivityCursor | null {
  const before = Array.isArray(params.before) ? params.before[0] : params.before;
  const beforeId = Array.isArray(params.beforeId) ? params.beforeId[0] : params.beforeId;
  if (!before || !beforeId) return null;
  const createdAt = new Date(before);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: beforeId };
}

/** Round-trips `parseCursor`, for a link to the next page. */
export function cursorToQuery(cursor: ActivityCursor): string {
  return new URLSearchParams({ before: cursor.createdAt.toISOString(), beforeId: cursor.id }).toString();
}

/** Round-trips `parseFilters`. Empty values are omitted so URLs stay short. */
export function filtersToQuery(filters: ActivityFilters): string {
  const params = new URLSearchParams();
  if (filters.families.length) params.set("family", filters.families.join(","));
  if (filters.outcomes.length) params.set("outcome", filters.outcomes.join(","));
  if (filters.actors.length) params.set("actor", filters.actors.join(","));
  if (filters.since) params.set("since", filters.since.toISOString());
  return params.toString();
}

/** The composite key an actor filter is stored and compared by — a label stands in for a worker's missing id. */
export function actorKey(actor: ActivityActor): string {
  return `${actor.type}:${actor.id ?? actor.label}`;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

export function toggleFamily(filters: ActivityFilters, family: ActivityFamily): ActivityFilters {
  return { ...filters, families: toggle(filters.families, family) };
}

export function toggleOutcome(filters: ActivityFilters, outcome: ActivityOutcome): ActivityFilters {
  return { ...filters, outcomes: toggle(filters.outcomes, outcome) };
}

export function clearFilters(filters: ActivityFilters): ActivityFilters {
  return { ...filters, families: [], outcomes: [], actors: [] };
}

export function hasActiveFilters(filters: ActivityFilters): boolean {
  return filters.families.length > 0 || filters.outcomes.length > 0 || filters.actors.length > 0 || filters.since !== null;
}
