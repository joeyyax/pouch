/** Which domains' delivery time is well above their own normal, from `domain_daily_stats`. */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { domainDailyStats } from "@/lib/db/schema";
import { DELIVERY_WINDOW_DAYS, readDeliveryShift, type DeliveryShift, type DeliveryTimeRow } from "@/lib/metrics/delivery-time";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DomainDeliveryShift extends DeliveryShift {
  domainId: string;
  organizationId: string;
}

/**
 * Domains whose latest p90 breaks the rule, for one organization, the domains named, or every
 * organization, as of `now`'s UTC day.
 */
export async function readDeliveryShifts(
  scope: { organizationId?: string; domainIds?: string[] },
  now: Date,
): Promise<Map<string, DomainDeliveryShift>> {
  if (scope.domainIds?.length === 0) return new Map();
  const oldest = new Date(now.getTime() - 2 * DELIVERY_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const rows = await db
    .select({
      domainId: domainDailyStats.domainId,
      organizationId: domainDailyStats.organizationId,
      day: domainDailyStats.day,
      deliveredCount: domainDailyStats.deliveredCount,
      p90Ms: domainDailyStats.deliveryP90Ms,
    })
    .from(domainDailyStats)
    .where(
      and(
        gte(domainDailyStats.day, oldest),
        lte(domainDailyStats.day, now.toISOString().slice(0, 10)),
        scope.organizationId ? eq(domainDailyStats.organizationId, scope.organizationId) : undefined,
        scope.domainIds ? inArray(domainDailyStats.domainId, scope.domainIds) : undefined,
      ),
    );

  const byDomain = new Map<string, { organizationId: string; rows: DeliveryTimeRow[] }>();
  for (const { domainId, organizationId, ...row } of rows) {
    const entry = byDomain.get(domainId) ?? { organizationId, rows: [] };
    entry.rows.push(row);
    byDomain.set(domainId, entry);
  }

  const shifts = new Map<string, DomainDeliveryShift>();
  for (const [domainId, { organizationId, rows: history }] of byDomain) {
    const shift = readDeliveryShift(history, now);
    if (shift) shifts.set(domainId, { ...shift, domainId, organizationId });
  }
  return shifts;
}
