import { sql } from "drizzle-orm";
import { check, foreignKey, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { providers } from "./providers";

/** The only id this table accepts. Settings here belong to the install, not an organization. */
export const SERVICE_SETTINGS_ID = "service";

export const serviceSettings = pgTable(
  "service_settings",
  {
    id: text("id").primaryKey().default(SERVICE_SETTINGS_ID),
    /**
     * Address Pouch's own mail sends from. Its domain resolves the organization, provider and
     * tenant. Null falls back to `support@` on the oldest verified domain. Stored as text, not a
     * domain id: deleting or unverifying the domain has to stop system mail rather than silently
     * reroute it through another organization's.
     */
    systemFromAddress: text("system_from_address"),
    /** Where as-needed operator alerts go. Null or empty falls back to the system from address. */
    systemAlertsTo: text("system_alerts_to").array(),
    /**
     * Shared provider a new organization is onboarded onto. One pointer, so two defaults can't
     * exist. Only a shared provider may be named, which the write path checks — the column
     * can't. Null means new organizations wait for an admin to assign one.
     */
    defaultProviderId: text("default_provider_id"),
    /** Values an admin set, by key in `lib/settings/registry.ts`. A missing or invalid one follows the entry's default. */
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("service_settings_singleton_check", sql`${table.id} = 'service'`),
    foreignKey({
      columns: [table.defaultProviderId],
      foreignColumns: [providers.id],
      name: "service_settings_default_provider_fk",
    }).onDelete("set null"),
  ],
);

export type ServiceSettingsRow = typeof serviceSettings.$inferSelect;
