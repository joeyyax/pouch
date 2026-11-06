import { check, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./auth";
import { enumCheck } from "./checks";
import { ORG_ROLES, type OrgRole } from "@/lib/auth/permissions";

/**
 * Org-level role. Orthogonal to `users.admin`: this decides what someone can do inside one
 * organization, never whether they can see another one.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role").$type<OrgRole>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("memberships_user_organization_unique").on(table.userId, table.organizationId),
    index("memberships_organization_idx").on(table.organizationId),
    index("memberships_user_idx").on(table.userId),
    check("memberships_role_check", enumCheck(table.role, ORG_ROLES)),
  ],
);
