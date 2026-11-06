/**
 * List membership. Every add records where it came from and, when double opt-in applies,
 * enters `pending` — the worker (`worker/list-confirm.ts`) sends the confirmation, never this
 * adapter directly, so every path that can add a member (an API `subscribe`, an import, a
 * manual add from the recipients view) goes through one place and can't forget it.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { listMemberships } from "@/lib/db/schema";
import type { ListMembershipRow, ListMemberAttributes, MembershipSource } from "@/lib/db/schema";
import { normalizeAddress, isEmailAddress } from "@/lib/addresses";
import { ApiError } from "@/lib/api/errors";
import { newId } from "@/lib/ids";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import type { UpdateMemberRequest } from "@/lib/schemas/list";
import { listFor, type ListCaller } from "./index";
import { serializeMembership, type SerializedMembership } from "./serialize";
import { keysetBefore } from "@/lib/db/keyset";

const PENDING_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export interface AddMembershipInput {
  organizationId: string;
  listId: string;
  address: string;
  source: MembershipSource;
  /** The list's own `double_opt_in` at the moment of this add — stored on the row itself. */
  doubleOptIn: boolean;
  sourceMessageId?: string | null;
  manualActor?: string | null;
  attributes?: ListMemberAttributes;
  /** Import only: the importer vouches this address already confirmed elsewhere. */
  confirmed?: boolean;
  /**
   * Records `list.member.added` when this add creates a row. An import records its own count
   * and a send's `subscribe` is a side effect of the message, so both leave this unset.
   */
  record?: { actor: ActivityActor; listName: string };
}

export interface AddMembershipResult {
  membership: ListMembershipRow;
  /** False when the address was already a member — never resurrects an unsubscribed one. */
  created: boolean;
}

/**
 * Inserts a membership, or returns the existing row untouched. An address that already
 * unsubscribed stays unsubscribed: re-adding it through `subscribe`, an import or a manual add
 * is never how consent comes back.
 */
export async function addMembership(input: AddMembershipInput): Promise<AddMembershipResult> {
  const address = normalizeAddress(input.address);
  if (!isEmailAddress(address)) {
    throw new ApiError("validation_failed", `"${input.address}" isn't a valid address.`, { field: "address" });
  }

  const now = await dbNow();
  const confirmedByImport = input.source === "import" && input.confirmed === true;
  const subscribedNow = !input.doubleOptIn || confirmedByImport;

  const values = {
    id: newId("listMembership"),
    organizationId: input.organizationId,
    listId: input.listId,
    address,
    status: (subscribedNow ? "subscribed" : "pending") as ListMembershipRow["status"],
    source: input.source,
    sourceMessageId: input.sourceMessageId ?? null,
    manualActor: input.manualActor ?? null,
    attributes: input.attributes ?? {},
    doubleOptIn: input.doubleOptIn,
    confirmedAt: subscribedNow ? now : null,
    confirmedBy: subscribedNow ? (confirmedByImport ? ("import" as const) : ("not_required" as const)) : null,
    pendingExpiresAt: subscribedNow ? null : new Date(now.getTime() + PENDING_EXPIRY_MS),
  };

  const [row] = await db.insert(listMemberships).values(values).onConflictDoNothing().returning();
  if (row) {
    if (input.record) {
      await recordActivity({
        organizationId: input.organizationId,
        action: "list.member.added",
        actor: input.record.actor,
        appliesTo: input.listId,
        subjectLabel: input.record.listName,
        metadata: { membershipId: row.id, source: input.source },
      });
    }
    return { membership: row, created: true };
  }

  const [existing] = await db
    .select()
    .from(listMemberships)
    .where(and(eq(listMemberships.listId, input.listId), eq(listMemberships.address, address)))
    .limit(1);
  if (!existing) throw new ApiError("provider_unavailable", "The membership couldn't be read back.");
  return { membership: existing, created: false };
}

export interface ListMembersFilters {
  status?: ListMembershipRow["status"];
}

export interface MembersPage {
  data: SerializedMembership[];
  next_cursor: string | null;
}

export async function listMembers(
  caller: ListCaller,
  listId: string,
  limit: number,
  cursor: string | undefined,
  filters: ListMembersFilters = {},
): Promise<MembersPage> {
  const list = await listFor(caller, listId);

  const after = cursor
    ? await db
        .select({ createdAt: listMemberships.createdAt, id: listMemberships.id })
        .from(listMemberships)
        .where(and(eq(listMemberships.listId, list.id), eq(listMemberships.id, cursor)))
        .limit(1)
    : [];
  const edge = after[0];

  const rows = await db
    .select()
    .from(listMemberships)
    .where(
      and(
        eq(listMemberships.listId, list.id),
        filters.status ? eq(listMemberships.status, filters.status) : undefined,
        edge ? keysetBefore({ table: listMemberships, sort: listMemberships.createdAt, id: listMemberships.id }, edge.id) : undefined,
      ),
    )
    .orderBy(desc(listMemberships.createdAt), desc(listMemberships.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return {
    data: page.map(serializeMembership),
    next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/**
 * Replaces a member's attribute map. The merge fields a batch substitutes are the only part of
 * a membership that changes — address, status and source are how it got here.
 */
export async function updateMember(
  caller: ListCaller,
  listId: string,
  membershipId: string,
  request: UpdateMemberRequest,
  actor: ActivityActor,
): Promise<SerializedMembership> {
  const list = await listFor(caller, listId);
  const [row] = await db
    .update(listMemberships)
    .set({ attributes: request.attributes, updatedAt: new Date() })
    .where(and(eq(listMemberships.listId, list.id), eq(listMemberships.id, membershipId)))
    .returning();
  if (!row) throw new ApiError("not_found", `No member with id ${membershipId} on this list.`);

  await recordActivity({
    organizationId: caller.organizationId,
    action: "list.member.updated",
    actor,
    appliesTo: list.id,
    subjectLabel: list.name,
    metadata: { membershipId: row.id, attributeKeys: Object.keys(row.attributes).sort() },
  });

  return serializeMembership(row);
}

/** Removes one member outright — the recipients view's "remove from list", not an unsubscribe. */
export async function removeMember(
  caller: ListCaller,
  listId: string,
  membershipId: string,
  actor: ActivityActor,
): Promise<{ id: string; removed: true }> {
  const list = await listFor(caller, listId);
  const [removed] = await db
    .delete(listMemberships)
    .where(and(eq(listMemberships.listId, list.id), eq(listMemberships.id, membershipId)))
    .returning({ id: listMemberships.id });
  if (!removed) throw new ApiError("not_found", `No member with id ${membershipId} on this list.`);

  await recordActivity({
    organizationId: caller.organizationId,
    action: "list.member.removed",
    actor,
    appliesTo: list.id,
    subjectLabel: list.name,
    metadata: { membershipId: removed.id },
  });

  return { id: removed.id, removed: true };
}

export { PENDING_EXPIRY_MS };
