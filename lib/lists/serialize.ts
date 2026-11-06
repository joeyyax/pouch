import type { ListMembershipRow, ListRow } from "@/lib/db/schema";

export interface MemberCounts {
  pending: number;
  subscribed: number;
  unsubscribed: number;
}

export interface SerializedList {
  id: string;
  domain_id: string;
  name: string;
  double_opt_in: boolean;
  created_at: string;
  updated_at: string;
  /** With `include=member_counts`. */
  member_counts?: MemberCounts;
}

export function serializeList(list: ListRow): SerializedList {
  return {
    id: list.id,
    domain_id: list.domainId,
    name: list.name,
    double_opt_in: list.doubleOptIn,
    created_at: list.createdAt.toISOString(),
    updated_at: list.updatedAt.toISOString(),
  };
}

export interface SerializedMembership {
  id: string;
  list_id: string;
  address: string;
  status: ListMembershipRow["status"];
  source: ListMembershipRow["source"];
  source_message_id: string | null;
  manual_actor: string | null;
  attributes: Record<string, string>;
  double_opt_in: boolean;
  confirmed_at: string | null;
  confirmed_by: ListMembershipRow["confirmedBy"];
  pending_expires_at: string | null;
  unsubscribed_at: string | null;
  created_at: string;
  updated_at: string;
}

export function serializeMembership(row: ListMembershipRow): SerializedMembership {
  return {
    id: row.id,
    list_id: row.listId,
    address: row.address,
    status: row.status,
    source: row.source,
    source_message_id: row.sourceMessageId,
    manual_actor: row.manualActor,
    attributes: row.attributes,
    double_opt_in: row.doubleOptIn,
    confirmed_at: row.confirmedAt?.toISOString() ?? null,
    confirmed_by: row.confirmedBy,
    pending_expires_at: row.pendingExpiresAt?.toISOString() ?? null,
    unsubscribed_at: row.unsubscribedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
