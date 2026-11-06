import type { AddressRow, AddressStatus } from "@/lib/db/schema";
import { inboundHost } from "@/lib/inbound/records";

export interface AddressCounts {
  received: number;
  /** Delivered on the current UTC day, against the organization's daily limit. */
  received_today: number;
  dropped_expired: number;
  dropped_over_limit: number;
  dropped_virus: number;
  forwarded: number;
}

export interface SerializedAddress {
  id: string;
  address: string;
  domain_id: string;
  local_part: string;
  label: string | null;
  status: AddressStatus;
  expires_at: string;
  message_cap: number | null;
  key_id: string | null;
  counts: AddressCounts;
  last_received_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What an address needs from its domain to spell itself out. */
export interface AddressDomain {
  name: string;
  inboundSubdomain: string;
}

/** The status as of `now`, ahead of the sweep. */
export function statusAt(row: Pick<AddressRow, "status" | "expiresAt">, now: Date): AddressStatus {
  if (row.status === "active" && row.expiresAt.getTime() <= now.getTime()) return "expired";
  return row.status;
}

export function serializeAddress(row: AddressRow, domain: AddressDomain, now: Date): SerializedAddress {
  return {
    id: row.id,
    address: `${row.localPart}@${inboundHost(domain.name, domain.inboundSubdomain)}`,
    domain_id: row.domainId,
    local_part: row.localPart,
    label: row.label,
    status: statusAt(row, now),
    expires_at: row.expiresAt.toISOString(),
    message_cap: row.messageCap,
    key_id: row.apiKeyId,
    counts: {
      received: row.receivedCount,
      received_today: row.receivedDay === now.toISOString().slice(0, 10) ? row.receivedToday : 0,
      dropped_expired: row.droppedExpiredCount,
      dropped_over_limit: row.droppedOverLimitCount,
      dropped_virus: row.droppedVirusCount,
      forwarded: row.forwardedCount,
    },
    last_received_at: row.lastReceivedAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
