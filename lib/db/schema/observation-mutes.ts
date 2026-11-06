import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { apiKeys } from "./api-keys";
import { users } from "./auth";

/**
 * An observation muted for one tag or one key, or turned off for the whole organization when
 * both are null. `key` is the observation's key as text, so a new observation needs no migration.
 */
export const observationMutes = pgTable(
  "observation_mutes",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    tag: text("tag"),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("observation_mutes_organization_idx").on(table.organizationId),
    uniqueIndex("observation_mutes_tag_idx")
      .on(table.organizationId, table.key, table.tag)
      .where(sql`${table.tag} is not null`),
    uniqueIndex("observation_mutes_key_idx")
      .on(table.organizationId, table.key, table.apiKeyId)
      .where(sql`${table.apiKeyId} is not null`),
    uniqueIndex("observation_mutes_off_idx")
      .on(table.organizationId, table.key)
      .where(sql`${table.tag} is null and ${table.apiKeyId} is null`),
    check("observation_mutes_one_subject_check", sql`${table.tag} is null or ${table.apiKeyId} is null`),
  ],
);

export type ObservationMuteRow = typeof observationMutes.$inferSelect;
