import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations";
import { users } from "./auth";

/** An offer of a membership, redeemed once through a token that expires. */
export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    token: text("token").notNull().unique(),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("invitations_organization_idx").on(table.organizationId),
    index("invitations_email_idx").on(table.email),
    // One live token per address per organization. Revoke or resend, never a second offer.
    uniqueIndex("invitations_pending_idx")
      .on(table.organizationId, table.email)
      .where(sql`status = 'pending'`),
  ],
);

export type InvitationRow = typeof invitations.$inferSelect;
