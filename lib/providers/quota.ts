import type { AccountQuota } from "@/lib/providers/adapters/types";

/** Operators hear about usage at this share of the daily quota. */
export const QUOTA_WARN_SHARE = 0.8;

export function quotaShare(quota: Pick<AccountQuota, "max24HourSend" | "sentLast24Hours">): number | null {
  if (!quota.max24HourSend || quota.max24HourSend <= 0 || quota.sentLast24Hours === null) return null;
  return quota.sentLast24Hours / quota.max24HourSend;
}
