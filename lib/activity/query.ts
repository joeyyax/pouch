/**
 * Activity log — read side. Server-only: never import this from a "use client" file (see
 * tests/unit/client-bundle.test.ts). Pure classification and filtering logic lives in the
 * sibling adapters, which stay client-safe.
 *
 * Cursor pagination is on `(created_at desc, id desc)` — the row id breaks ties within the
 * same millisecond, so two rows inserted by the same statement can't shadow each other
 * across a page boundary the way a `created_at`-only cursor would.
 *
 * Subject resolution: `applies_to` holds an id (or, for a suppression, the row's own id —
 * never the address itself, see below) with no snapshot of the current name for domains and
 * keys other than what's already logged in `subject_label` at write time. A link is only
 * rendered when the subject still exists, checked with one batched query per family per page
 * — otherwise the row falls back to the write-time label as plain text.
 *
 * Suppression addresses are the one deliberate exception to snapshotting: `docs/engineering.md`
 * promises an address can be purged on request, and a suppression is the one place in this
 * log where the subject genuinely is an address. Storing that address in `subject_label` or
 * metadata would recreate what the purge removes. Instead the activity row holds only the
 * suppression's own id; the address is read live from the suppression row when it still
 * exists, and never persisted here. Deleting the suppression (already how removal works —
 * see lib/messages/suppression.ts `unsuppress`) makes the address unreachable from this log
 * too, with no separate purge path to maintain.
 *
 * Single-address list rows follow the same rule (#352): metadata holds `membershipId` or
 * `domainUnsubscribeId`, and the address is read from that row while it exists.
 */
import { and, count, desc, eq, gte, inArray, isNull, or, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, apiKeys, domainUnsubscribes, domains, listMemberships, suppressions } from "@/lib/db/schema";
import type { ActivityFamily } from "@/lib/db/schema/activity";
import { actorKey } from "./filter";
import { isOrganizationWide } from "./group";
import type {
  ActivityActorOption,
  ActivityCursor,
  ActivityFacets,
  ActivityFilters,
  ActivityListItem,
  ActivityOutcome,
} from "./types";
import { keysetBefore } from "@/lib/db/keyset";

export const ACTIVITY_PAGE_SIZE = 50;

/** One `type:id-or-label` filter value split back into a matchable pair. */
function splitActorKey(key: string): { type: string; idOrLabel: string } {
  const separator = key.indexOf(":");
  return separator === -1 ? { type: key, idOrLabel: "" } : { type: key.slice(0, separator), idOrLabel: key.slice(separator + 1) };
}

function actorCondition(actors: string[]): SQL | undefined {
  if (!actors.length) return undefined;
  const parts = actors.map((key) => {
    const { type, idOrLabel } = splitActorKey(key);
    return and(
      eq(activity.actorType, type as ActivityListItem["actor"]["type"]),
      idOrLabel ? or(eq(activity.actorId, idOrLabel), eq(activity.actorLabel, idOrLabel)) : undefined,
    );
  });
  return or(...parts);
}

/** The organization and filter conditions every activity read shares. */
export function scopeConditions(organizationId: string, filters: ActivityFilters): SQL[] {
  const conditions: SQL[] = [eq(activity.organizationId, organizationId)];
  if (filters.families.length) conditions.push(inArray(activity.family, filters.families));
  if (filters.outcomes.length) conditions.push(inArray(activity.outcome, filters.outcomes));
  if (filters.since) conditions.push(gte(activity.createdAt, filters.since));
  const actors = actorCondition(filters.actors);
  if (actors) conditions.push(actors);
  return conditions;
}

// Only the id is read: the page's own organization scope keeps a foreign id from matching rows.
function cursorCondition(cursor: Pick<ActivityCursor, "id"> | null): SQL | undefined {
  if (!cursor) return undefined;
  return keysetBefore({ table: activity, sort: activity.createdAt, id: activity.id }, cursor.id);
}

/** Existence + current name for the ids a page of rows points at, so a link only renders live ones. */
async function resolveSubjects(
  organizationId: string,
  rows: { family: ActivityFamily; appliesTo: string | null }[],
): Promise<Map<string, { href: string; label: string }>> {
  const byFamily = new Map<ActivityFamily, string[]>();
  for (const row of rows) {
    if (!row.appliesTo) continue;
    byFamily.set(row.family, [...(byFamily.get(row.family) ?? []), row.appliesTo]);
  }

  const result = new Map<string, { href: string; label: string }>();

  const domainIds = [...(byFamily.get("domain") ?? [])];
  if (domainIds.length) {
    const found = await db
      .select({ id: domains.id, name: domains.name })
      .from(domains)
      .where(and(eq(domains.organizationId, organizationId), inArray(domains.id, domainIds)));
    for (const row of found) result.set(row.id, { href: `/domains/${row.id}`, label: row.name });
  }

  // Key and webhook rows both link into the key detail screen — an endpoint has no route of
  // its own (registered on the key's page, per docs/api/conventions.md).
  const keyIds = [...(byFamily.get("key") ?? [])];
  if (keyIds.length) {
    const found = await db
      .select({ id: apiKeys.id, name: apiKeys.name })
      .from(apiKeys)
      .where(and(eq(apiKeys.organizationId, organizationId), inArray(apiKeys.id, keyIds)));
    for (const row of found) result.set(row.id, { href: `/keys/${row.id}`, label: row.name });
  }

  const suppressionIds = [...(byFamily.get("suppression") ?? [])];
  if (suppressionIds.length) {
    const found = await db
      .select({ id: suppressions.id, address: suppressions.address })
      .from(suppressions)
      .where(and(eq(suppressions.organizationId, organizationId), inArray(suppressions.id, suppressionIds)));
    for (const row of found) {
      result.set(row.id, { href: `/suppressions?address=${encodeURIComponent(row.address)}`, label: row.address });
    }
  }

  return result;
}

/** Resolves a webhook row's key id from its metadata, when the write side recorded one. */
async function resolveWebhookKeys(
  organizationId: string,
  rows: { family: ActivityFamily; metadata: Record<string, unknown> | null }[],
): Promise<Map<string, { href: string; label: string }>> {
  const keyIds = rows
    .filter((row) => row.family === "webhook")
    .map((row) => (typeof row.metadata?.apiKeyId === "string" ? row.metadata.apiKeyId : null))
    .filter((id): id is string => id !== null);
  if (!keyIds.length) return new Map();

  const found = await db
    .select({ id: apiKeys.id, name: apiKeys.name })
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, organizationId), inArray(apiKeys.id, [...new Set(keyIds)])));
  return new Map(found.map((row) => [row.id, { href: `/keys/${row.id}`, label: row.name }]));
}

function metadataId(row: { metadata: Record<string, unknown> | null }, key: string): string | null {
  const value = row.metadata?.[key];
  return typeof value === "string" ? value : null;
}

/** Live addresses for the list members and domain stops a page of rows names, keyed by row id. */
async function resolveListAddresses(
  organizationId: string,
  rows: { family: ActivityFamily; metadata: Record<string, unknown> | null }[],
): Promise<Map<string, string>> {
  const listRows = rows.filter((row) => row.family === "list");
  const membershipIds = [...new Set(listRows.map((row) => metadataId(row, "membershipId")).filter((id) => id !== null))];
  const stopIds = [...new Set(listRows.map((row) => metadataId(row, "domainUnsubscribeId")).filter((id) => id !== null))];

  const [members, stops] = await Promise.all([
    membershipIds.length
      ? db
          .select({ id: listMemberships.id, address: listMemberships.address })
          .from(listMemberships)
          .where(and(eq(listMemberships.organizationId, organizationId), inArray(listMemberships.id, membershipIds)))
      : [],
    stopIds.length
      ? db
          .select({ id: domainUnsubscribes.id, address: domainUnsubscribes.address })
          .from(domainUnsubscribes)
          .where(and(eq(domainUnsubscribes.organizationId, organizationId), inArray(domainUnsubscribes.id, stopIds)))
      : [],
  ]);
  return new Map([...members, ...stops].map((row) => [row.id, row.address]));
}

function toListItem(
  row: typeof activity.$inferSelect,
  subjects: Map<string, { href: string; label: string }>,
  webhookKeys: Map<string, { href: string; label: string }>,
  addresses: Map<string, string>,
): ActivityListItem {
  const resolved = row.appliesTo ? subjects.get(row.appliesTo) : undefined;
  const apiKeyId = typeof row.metadata?.apiKeyId === "string" ? row.metadata.apiKeyId : null;
  const webhookKey = row.family === "webhook" && apiKeyId ? webhookKeys.get(apiKeyId) : undefined;

  // A suppression's live address wins when the row still exists — nothing about it is
  // persisted on this table, so a gone suppression has no address to fall back to at all.
  const label = row.family === "suppression" ? (resolved?.label ?? null) : (row.subjectLabel ?? resolved?.label ?? null);

  const addressRef = row.family === "list" ? (metadataId(row, "membershipId") ?? metadataId(row, "domainUnsubscribeId")) : null;

  return {
    id: row.id,
    action: row.action,
    family: row.family,
    outcome: row.outcome,
    actor: { type: row.actorType, id: row.actorId, label: row.actorLabel },
    appliesTo: row.appliesTo,
    subjectLabel: label,
    subjectHref: resolved?.href ?? webhookKey?.href ?? null,
    address: addressRef ? (addresses.get(addressRef) ?? null) : null,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

export interface ActivityPage {
  rows: ActivityListItem[];
  nextCursor: ActivityCursor | null;
}

/** Splits the spare row off a `limit + 1` read into the page and the cursor that follows it. */
function splitPage(rows: (typeof activity.$inferSelect)[], limit: number) {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { page, nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null };
}

export async function listActivity(
  organizationId: string,
  filters: ActivityFilters,
  cursor: Pick<ActivityCursor, "id"> | null = null,
  limit = ACTIVITY_PAGE_SIZE,
): Promise<ActivityPage> {
  const conditions = scopeConditions(organizationId, filters);
  const cursorClause = cursorCondition(cursor);
  if (cursorClause) conditions.push(cursorClause);

  // One extra row decides whether a next page exists, cheaper than a count() on a growing table.
  const rows = await db
    .select()
    .from(activity)
    .where(and(...conditions))
    .orderBy(desc(activity.createdAt), desc(activity.id))
    .limit(limit + 1);

  const { page, nextCursor } = splitPage(rows, limit);
  const [subjects, webhookKeys, addresses] = await Promise.all([
    resolveSubjects(organizationId, page),
    resolveWebhookKeys(organizationId, page),
    resolveListAddresses(organizationId, page),
  ]);

  return { rows: page.map((row) => toListItem(row, subjects, webhookKeys, addresses)), nextCursor };
}

/**
 * The service's own activity: rows that belong to no organization, written when an admin acts
 * service-wide. Subjects aren't resolved to links — they live in other organizations, or in none,
 * and the stored labels are what the row means.
 */
export async function listServiceActivity(
  cursor: ActivityCursor | null = null,
  limit = ACTIVITY_PAGE_SIZE,
): Promise<ActivityPage> {
  const conditions: SQL[] = [isNull(activity.organizationId)];
  const cursorClause = cursorCondition(cursor);
  if (cursorClause) conditions.push(cursorClause);

  const rows = await db
    .select()
    .from(activity)
    .where(and(...conditions))
    .orderBy(desc(activity.createdAt), desc(activity.id))
    .limit(limit + 1);

  const { page, nextCursor } = splitPage(rows, limit);
  return { rows: page.map((row) => toListItem(row, new Map(), new Map(), new Map())), nextCursor };
}

export async function readActivity(organizationId: string, id: string): Promise<ActivityListItem | null> {
  const [row] = await db
    .select()
    .from(activity)
    .where(and(eq(activity.organizationId, organizationId), eq(activity.id, id)))
    .limit(1);
  if (!row) return null;

  const [subjects, webhookKeys, addresses] = await Promise.all([
    resolveSubjects(organizationId, [row]),
    resolveWebhookKeys(organizationId, [row]),
    resolveListAddresses(organizationId, [row]),
  ]);
  return toListItem(row, subjects, webhookKeys, addresses);
}

/** Bounds an unbounded facet scan when the caller applies no window of its own. */
const DEFAULT_FACET_WINDOW_MS = 90 * 24 * 60 * 60_000;

/**
 * Family and outcome counts, grouped in the database rather than loaded row by row — the
 * ledger is unbounded and growing. An empty family never becomes a chip, so choosing one
 * can't lead to an empty view. `since` narrows the window; family and outcome selections do
 * not, so turning one chip off never hides the others' counts.
 */
export async function activityFacets(organizationId: string, since: Date | null): Promise<ActivityFacets> {
  const floor = since ?? new Date(Date.now() - DEFAULT_FACET_WINDOW_MS);
  const conditions: SQL[] = [eq(activity.organizationId, organizationId), gte(activity.createdAt, floor)];

  const rows = await db
    .select({ family: activity.family, outcome: activity.outcome, total: count() })
    .from(activity)
    .where(and(...conditions))
    .groupBy(activity.family, activity.outcome);

  const families = new Set<ActivityFamily>();
  const outcomes: Record<ActivityOutcome, number> = { success: 0, failure: 0, neutral: 0 };
  for (const row of rows) {
    families.add(row.family);
    outcomes[row.outcome] += row.total;
  }
  return { families: [...families], outcomes };
}

/**
 * Distinct actors seen in the window, newest first — the options an actor filter offers.
 * Capped: this is a picklist, not a report, and an organization with a runaway number of
 * distinct actors (keys churning, say) shouldn't turn the filter bar into a scroll.
 */
const MAX_ACTOR_OPTIONS = 25;

export async function activityActors(organizationId: string, since: Date | null): Promise<ActivityActorOption[]> {
  const floor = since ?? new Date(Date.now() - DEFAULT_FACET_WINDOW_MS);
  const rows = await db
    .select({ type: activity.actorType, id: activity.actorId, label: activity.actorLabel, createdAt: activity.createdAt })
    .from(activity)
    .where(and(eq(activity.organizationId, organizationId), gte(activity.createdAt, floor)))
    .orderBy(desc(activity.createdAt))
    .limit(2000);

  const seen = new Map<string, ActivityActorOption>();
  for (const row of rows) {
    const actor = { type: row.type, id: row.id, label: row.label };
    const key = actorKey(actor);
    if (!seen.has(key)) seen.set(key, { key, actor });
    if (seen.size >= MAX_ACTOR_OPTIONS) break;
  }
  return [...seen.values()];
}

export { isOrganizationWide };
export { actorKey };
