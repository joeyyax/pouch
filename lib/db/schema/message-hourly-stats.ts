import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { domains } from "./domains";

/** Message counts per latency bucket (`lib/stats/histogram.ts`), keyed by bucket index, with the exact ends. */
export interface LatencyHistogram {
  counts: Record<string, number>;
  min: number;
  max: number;
}

/**
 * Messages accepted in one UTC hour, per domain, key and mode, as they stand at the last rollup
 * (`lib/stats/rollup.ts`). Hours older than the live day only. Kept 190 days.
 */
export const messageHourlyStats = pgTable(
  "message_hourly_stats",
  {
    /** Null on a cell of the service's own mail. */
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    /** No foreign key: a deleted key's id is still the honest answer for what it sent. */
    apiKeyId: text("api_key_id"),
    testMode: boolean("test_mode").notNull(),
    /** Start of the hour `created_at` falls in. */
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    total: integer("total").notNull(),
    queued: integer("queued").notNull(),
    sent: integer("sent").notNull(),
    deferred: integer("deferred").notNull(),
    delivered: integer("delivered").notNull(),
    bounced: integer("bounced").notNull(),
    complained: integer("complained").notNull(),
    failed: integer("failed").notNull(),
    /** Sent and marked by the abandon sweep. A subset of `sent`. */
    abandoned: integer("abandoned").notNull(),
    /** Messages with a `sent_at`, and their attempts summed. */
    handedOver: integer("handed_over").notNull(),
    attempts: integer("attempts").notNull(),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    /** Accepted to handed over, handed over to delivered, accepted to delivered. Null with no samples. */
    queueLatency: jsonb("queue_latency").$type<LatencyHistogram>(),
    providerLatency: jsonb("provider_latency").$type<LatencyHistogram>(),
    endToEndLatency: jsonb("end_to_end_latency").$type<LatencyHistogram>(),
    /** Bounce and complaint reasons on these messages' events, verbatim, counted. */
    reasons: jsonb("reasons").$type<Record<string, number>>().notNull(),
  },
  (table) => [
    unique("message_hourly_stats_cell_key")
      .on(table.organizationId, table.hour, table.domainId, table.apiKeyId, table.testMode)
      .nullsNotDistinct(),
    index("message_hourly_stats_hour_idx").on(table.hour),
  ],
);

export type MessageHourlyStatsRow = typeof messageHourlyStats.$inferSelect;

/** One row: which hours `message_hourly_stats` holds, and where the next run picks up. */
export const messageStatsRollup = pgTable("message_stats_rollup", {
  id: text("id").primaryKey().default("rollup"),
  /** Hours from here hold every message. The retention cutoff after the first run. */
  coveredFrom: timestamp("covered_from", { withTimezone: true }).notNull(),
  /** Hours before here hold every message, as of `ran_at`. */
  coveredUntil: timestamp("covered_until", { withTimezone: true }).notNull(),
  /** The last run's start. The next run recomputes hours with a message updated since. */
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull(),
});
