import { sql } from "drizzle-orm";
import { boolean, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./auth";

/**
 * A person's choice for one notification type, in every organization they own. No row means the
 * type's default. `type` is the key as text, so a new type needs no migration.
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    email: boolean("email").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.type] })],
);

/**
 * The last time a type was emailed about one subject in an organization. `cleared_at` is null
 * while the condition still holds, so it doesn't mail again until it clears.
 */
export const notificationSends = pgTable(
  "notification_sends",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    /** What the notice is about: a domain id, a tag, a hashed address. */
    about: text("about").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.type, table.about] }),
    index("notification_sends_held_idx").on(table.organizationId, table.type).where(sql`${table.clearedAt} is null`),
  ],
);

export type NotificationSendRow = typeof notificationSends.$inferSelect;
