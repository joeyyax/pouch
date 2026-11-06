import { index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Per-address delivery history, per organization. Kept indefinitely, like the suppression
 * list — see docs/product/brief.md, "Suppressions". Raw message_events can still age out on
 * retention's cutoff because this rollup already holds what a send-time warning needs.
 *
 * Updated as events arrive (`lib/messages/history.ts`), not computed from message_events on
 * read: this runs once per recipient on every send, so a fixed-size row beats a scan.
 */
export const recipientHistory = pgTable(
  "recipient_history",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Normalized address: domain part lowercased, local part preserved. */
    address: text("address").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    lastBouncedAt: timestamp("last_bounced_at", { withTimezone: true }),
    bounceCount: integer("bounce_count").notNull().default(0),
    lastComplainedAt: timestamp("last_complained_at", { withTimezone: true }),
    complaintCount: integer("complaint_count").notNull().default(0),
    lastDeferredAt: timestamp("last_deferred_at", { withTimezone: true }),
    /** Deferrals since the last delivery, not for all time — a delivery resets it. */
    deferredCount: integer("deferred_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.address] }),
    index("recipient_history_organization_idx").on(table.organizationId),
  ],
);

export type RecipientHistoryRow = typeof recipientHistory.$inferSelect;
