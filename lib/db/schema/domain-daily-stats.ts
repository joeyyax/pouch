import { date, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { domains } from "./domains";

/**
 * One row per domain per UTC day: delivery and volume over rolling windows by `sent_at`, rewritten
 * hourly by the domain-stats loop (`lib/domains/daily-stats.ts`). Kept 90 days. Test mode excluded.
 */
export const domainDailyStats = pgTable(
  "domain_daily_stats",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    /** The UTC day of the run. A day's row settles at its last run. */
    day: date("day", { mode: "string" }).notNull(),
    /** Both windows end here. */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    /** Start of the delivery window: 7 days before `computed_at`. */
    deliveryWindowStart: timestamp("delivery_window_start", { withTimezone: true }).notNull(),
    /** Messages sent in the delivery window that reached delivered. */
    deliveredCount: integer("delivered_count").notNull(),
    /** Sent to delivered, in ms. Null when nothing was delivered. */
    deliveryMinMs: integer("delivery_min_ms"),
    deliveryP10Ms: integer("delivery_p10_ms"),
    deliveryP25Ms: integer("delivery_p25_ms"),
    deliveryP50Ms: integer("delivery_p50_ms"),
    deliveryP75Ms: integer("delivery_p75_ms"),
    deliveryP90Ms: integer("delivery_p90_ms"),
    deliveryP99Ms: integer("delivery_p99_ms"),
    deliveryMaxMs: integer("delivery_max_ms"),
    /** Start of the volume window: 28 days before `computed_at`. */
    volumeWindowStart: timestamp("volume_window_start", { withTimezone: true }).notNull(),
    /** Messages sent in the volume window, by UTC hour of day. Always 24 slots. */
    hourlyVolume: integer("hourly_volume").array().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.domainId, table.day] }),
    index("domain_daily_stats_organization_idx").on(table.organizationId),
    index("domain_daily_stats_day_idx").on(table.day),
  ],
);

export type DomainDailyStatsRow = typeof domainDailyStats.$inferSelect;
