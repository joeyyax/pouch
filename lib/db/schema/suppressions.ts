import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { messages } from "./messages";
import { enumCheck } from "./checks";
import { SUPPRESSION_REASONS } from "../enums";

export { SUPPRESSION_REASONS };
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** An address that hard-bounced or complained on any domain. Sends to it fail at the API. */
export const suppressions = pgTable(
  "suppressions",
  {
    id: text("id").primaryKey(),
    /** Null on the service's own list, from a bounce or complaint on its mail. */
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    /** Normalized address: domain part lowercased, local part preserved. */
    address: text("address").notNull(),
    reason: text("reason").$type<SuppressionReason>().notNull(),
    /** The provider's reason, verbatim. */
    detail: text("detail"),
    /** The provider's bounce classification, as `Permanent/NoEmail`. Null for complaints, manual adds and imports. */
    bounceType: text("bounce_type"),
    /** Message that caused the suppression, when there was one. */
    sourceMessageId: text("source_message_id").references(() => messages.id, { onDelete: "set null" }),
    /** Where an imported suppression came from, such as `postmark`. Null for a bounce, complaint or single add. */
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("suppressions_address_idx").on(table.organizationId, table.address),
    uniqueIndex("suppressions_service_address_idx")
      .on(table.address)
      .where(sql`${table.organizationId} is null`),
    index("suppressions_organization_idx").on(table.organizationId),
    index("suppressions_organization_created_idx").on(table.organizationId, table.createdAt),
    check("suppressions_reason_check", enumCheck(table.reason, SUPPRESSION_REASONS)),
  ],
);

export type SuppressionRow = typeof suppressions.$inferSelect;
