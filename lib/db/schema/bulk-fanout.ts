import { date, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { apiKeys } from "./api-keys";

/**
 * One row per key, rendered-body hash, day and recipient the key has sent that exact body to.
 * `count(*)` grouped by key, hash and day is the daily fan-out count `lib/messages/bulk-detect.ts`
 * checks against the threshold. `recipientHash` proves membership without holding the address a
 * second time — `messages.recipients` already has it — and `bodyHash` can't be turned back into
 * a body, so this table adds detection, not a second copy of anything sensitive.
 */
export const bulkFanoutRecipients = pgTable(
  "bulk_fanout_recipients",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    /** sha256 of the rendered body: html after layout wrapping, plus text. */
    bodyHash: text("body_hash").notNull(),
    /** UTC calendar day, from the database's clock. */
    day: date("day", { mode: "string" }).notNull(),
    /** sha256 of the normalized recipient address. */
    recipientHash: text("recipient_hash").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.apiKeyId, table.bodyHash, table.day, table.recipientHash] }),
    index("bulk_fanout_recipients_organization_idx").on(table.organizationId),
  ],
);
