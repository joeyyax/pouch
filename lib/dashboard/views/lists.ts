/** The shapes the lists screens render. Client-safe: nothing here reaches Postgres. */
import type { MembershipStatus } from "@/lib/db/schema";

export type MemberCounts = Record<MembershipStatus, number>;

export const EMPTY_MEMBER_COUNTS: MemberCounts = { pending: 0, subscribed: 0, unsubscribed: 0 };

export function memberTotal(counts: MemberCounts): number {
  return counts.pending + counts.subscribed + counts.unsubscribed;
}
