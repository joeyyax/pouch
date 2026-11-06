/**
 * List CRUD (#7). Reads the `domains` table directly rather than going through
 * `lib/domains` — that adapter's business logic (verification, moves, DNS) belongs to a
 * different slice; a list only needs a domain's id, name and organization to exist and be in
 * the caller's scope.
 */
import { and, count, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, lists, listMemberships } from "@/lib/db/schema";
import type { ListRow } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { keyCanAccessDomain } from "@/lib/api/keys";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { newId } from "@/lib/ids";
import type { CreateListRequest, UpdateListRequest } from "@/lib/schemas/list";
import { serializeList, type MemberCounts, type SerializedList } from "./serialize";
import { keysetBefore } from "@/lib/db/keyset";

/** Who is asking. An API key and a dashboard session differ only in scope. */
export interface ListCaller {
  organizationId: string;
  domainIds: string[];
  actor: ActivityActor;
}

async function domainNameFor(organizationId: string, domainId: string): Promise<string> {
  const [domain] = await db
    .select({ name: domains.name })
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), eq(domains.id, domainId)))
    .limit(1);
  return domain?.name ?? domainId;
}

/** Loads the domain a list request names, checked for existence and scope. */
async function assertDomainAccessible(caller: ListCaller, domainId: string): Promise<string> {
  const [domain] = await db
    .select({ id: domains.id, name: domains.name })
    .from(domains)
    .where(and(eq(domains.organizationId, caller.organizationId), eq(domains.id, domainId)))
    .limit(1);
  if (!domain) throw new ApiError("not_found", `No domain with id ${domainId}.`, { field: "domain_id" });
  if (!keyCanAccessDomain(caller, domain.id)) {
    throw new ApiError("key_not_scoped", `This key can't manage lists on ${domain.name}.`);
  }
  return domain.name;
}

/** Loads a list in the caller's organization and scope, or throws the error that says why not. */
export async function listFor(caller: ListCaller, id: string): Promise<ListRow> {
  const [list] = await db
    .select()
    .from(lists)
    .where(and(eq(lists.organizationId, caller.organizationId), eq(lists.id, id)))
    .limit(1);
  if (!list) throw new ApiError("not_found", `No list with id ${id}.`);
  if (!keyCanAccessDomain(caller, list.domainId)) {
    throw new ApiError("key_not_scoped", `This key can't reach this list.`);
  }
  return list;
}

export async function createList(caller: ListCaller, request: CreateListRequest): Promise<SerializedList> {
  const domainName = await assertDomainAccessible(caller, request.domain_id);

  const [existing] = await db
    .select({ id: lists.id })
    .from(lists)
    .where(and(eq(lists.domainId, request.domain_id), eq(lists.name, request.name)))
    .limit(1);
  if (existing) {
    throw new ApiError("validation_failed", `A list named "${request.name}" already exists on ${domainName}.`, {
      field: "name",
    });
  }

  const [row] = await db
    .insert(lists)
    .values({
      id: newId("list"),
      organizationId: caller.organizationId,
      domainId: request.domain_id,
      name: request.name,
      doubleOptIn: request.double_opt_in ?? true,
    })
    .returning();
  if (!row) throw new ApiError("provider_unavailable", "The list couldn't be created.");

  await recordActivity({
    organizationId: caller.organizationId,
    action: "list.created",
    actor: caller.actor,
    appliesTo: row.id,
    subjectLabel: row.name,
  });

  return serializeList(row);
}

export interface ListListsFilters {
  domain?: string;
}

export interface ListPage {
  data: SerializedList[];
  next_cursor: string | null;
}

export async function listLists(
  caller: ListCaller,
  limit: number,
  cursor: string | undefined,
  filters: ListListsFilters,
  options: { memberCounts?: boolean } = {},
): Promise<ListPage> {
  const after = cursor
    ? await db
        .select({ createdAt: lists.createdAt, id: lists.id })
        .from(lists)
        .where(and(eq(lists.organizationId, caller.organizationId), eq(lists.id, cursor)))
        .limit(1)
    : [];
  const edge = after[0];

  const rows = await db
    .select()
    .from(lists)
    .where(
      and(
        eq(lists.organizationId, caller.organizationId),
        caller.domainIds.length > 0
          ? or(...caller.domainIds.map((id) => eq(lists.domainId, id)))
          : undefined,
        filters.domain ? eq(lists.domainId, filters.domain) : undefined,
        edge ? keysetBefore({ table: lists, sort: lists.createdAt, id: lists.id }, edge.id) : undefined,
      ),
    )
    .orderBy(desc(lists.createdAt), desc(lists.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const counts = options.memberCounts ? await memberCountsFor(caller.organizationId, page.map((row) => row.id)) : null;
  return {
    data: page.map((row) => (counts ? { ...serializeList(row), member_counts: counts.get(row.id)! } : serializeList(row))),
    next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function countLists(caller: ListCaller, filters: ListListsFilters = {}): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(lists)
    .where(
      and(
        eq(lists.organizationId, caller.organizationId),
        caller.domainIds.length > 0 ? or(...caller.domainIds.map((id) => eq(lists.domainId, id))) : undefined,
        filters.domain ? eq(lists.domainId, filters.domain) : undefined,
      ),
    );
  return row?.total ?? 0;
}

export async function readList(caller: ListCaller, id: string, options: { memberCounts?: boolean } = {}): Promise<SerializedList> {
  const list = await listFor(caller, id);
  if (!options.memberCounts) return serializeList(list);
  return { ...serializeList(list), member_counts: (await memberCountsFor(caller.organizationId, [list.id])).get(list.id)! };
}

/** Members of each list by status, in one grouped read. Every status is present, zero when empty. */
async function memberCountsFor(organizationId: string, listIds: string[]): Promise<Map<string, MemberCounts>> {
  const counts = new Map<string, MemberCounts>(listIds.map((id) => [id, { pending: 0, subscribed: 0, unsubscribed: 0 }]));
  if (listIds.length === 0) return counts;
  const rows = await db
    .select({ listId: listMemberships.listId, status: listMemberships.status, total: count() })
    .from(listMemberships)
    .where(and(eq(listMemberships.organizationId, organizationId), inArray(listMemberships.listId, listIds)))
    .groupBy(listMemberships.listId, listMemberships.status);
  for (const row of rows) {
    const entry = counts.get(row.listId);
    if (entry) entry[row.status] = row.total;
  }
  return counts;
}

/**
 * Renames a list or changes its opt-in mode. `double_opt_in` governs adds from here on — a
 * membership stores the mode it was added under, so nothing already on the list changes state.
 */
export async function updateList(caller: ListCaller, id: string, request: UpdateListRequest): Promise<SerializedList> {
  const list = await listFor(caller, id);

  if (request.name !== undefined && request.name !== list.name) {
    const [clash] = await db
      .select({ id: lists.id })
      .from(lists)
      .where(and(eq(lists.domainId, list.domainId), eq(lists.name, request.name)))
      .limit(1);
    if (clash) {
      const domainName = await domainNameFor(caller.organizationId, list.domainId);
      throw new ApiError("validation_failed", `A list named "${request.name}" already exists on ${domainName}.`, {
        field: "name",
      });
    }
  }

  const [row] = await db
    .update(lists)
    .set({
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.double_opt_in !== undefined ? { doubleOptIn: request.double_opt_in } : {}),
      updatedAt: new Date(),
    })
    .where(eq(lists.id, list.id))
    .returning();
  if (!row) throw new ApiError("not_found", `No list with id ${id}.`);

  await recordActivity({
    organizationId: caller.organizationId,
    action: "list.updated",
    actor: caller.actor,
    appliesTo: row.id,
    subjectLabel: row.name,
    metadata: {
      ...(request.name !== undefined && request.name !== list.name ? { from: list.name, to: row.name } : {}),
      ...(request.double_opt_in !== undefined && request.double_opt_in !== list.doubleOptIn
        ? { doubleOptIn: row.doubleOptIn }
        : {}),
    },
  });

  return serializeList(row);
}

export async function deleteList(caller: ListCaller, id: string): Promise<{ id: string; deleted: true }> {
  const list = await listFor(caller, id);
  await db.delete(listMemberships).where(eq(listMemberships.listId, list.id));
  await db.delete(lists).where(eq(lists.id, list.id));

  await recordActivity({
    organizationId: caller.organizationId,
    action: "list.deleted",
    actor: caller.actor,
    appliesTo: list.id,
    subjectLabel: list.name,
  });

  return { id: list.id, deleted: true };
}

export { domainNameFor };
