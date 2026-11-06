import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * Per-user digest cadence. A missing row means the defaults below — weekly on, daily and
 * monthly off — so a user who never opens the settings screen still gets the one digest
 * `docs/decisions.md` calls the default, and nothing else.
 */
export const digestPreferences = pgTable("digest_preferences", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  daily: boolean("daily").notNull().default(false),
  weekly: boolean("weekly").notNull().default(true),
  monthly: boolean("monthly").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
