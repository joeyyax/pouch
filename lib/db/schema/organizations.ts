import { boolean, check, foreignKey, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { nullableEnumCheck } from "./checks";
import { providers } from "./providers";

/** Who put a suspension in place: an operator, the org-level stall guard, or the provider itself. */
export const SUSPENSION_SOURCES = ["manual", "reputation", "provider"] as const;
export type SuspensionSource = (typeof SUSPENSION_SOURCES)[number];

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    /** How long a message body stays readable before the worker shreds its key. */
    bodyRetentionDays: integer("body_retention_days").notNull().default(45),
    /** Active addresses the organization may hold, set by an admin. Null follows `address_limit_default`. */
    addressLimit: integer("address_limit"),
    /** Messages one address may receive per UTC day, set by an admin. Null follows `address_daily_message_limit_default`. */
    addressDailyMessageLimit: integer("address_daily_message_limit"),
    /** Whether domains here get the report host's `rua` and the report panel. Set by an owner. */
    dmarcReportsEnabled: boolean("dmarc_reports_enabled").notNull().default(true),
    /** Set while the organization is suspended. Cleared only by an operator. */
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    /** The sentence the dashboard and the API error show. */
    suspendReason: text("suspend_reason"),
    suspendSource: text("suspend_source").$type<SuspensionSource | null>(),
    /** Structured context: the stall verdict for `reputation`, the provider's own status for `provider`. */
    suspendDetail: jsonb("suspend_detail").$type<Record<string, unknown> | null>(),
    /** Last time the org-level stall guard evaluated this organization. */
    suspensionCheckedAt: timestamp("suspension_checked_at", { withTimezone: true }),
    /** The assigned provider new domains bind to. Null means nothing is assigned yet. */
    providerId: text("provider_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("organizations_suspend_source_check", nullableEnumCheck(table.suspendSource, SUSPENSION_SOURCES)),
    // The migration narrows the delete action to `set null (provider_id)`.
    foreignKey({
      columns: [table.id, table.providerId],
      foreignColumns: [providers.organizationId, providers.id],
      name: "organizations_provider_fk",
    }).onDelete("set null"),
  ],
);

export type OrganizationRow = typeof organizations.$inferSelect;
