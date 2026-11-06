import { index, jsonb, pgTable, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * One set of DNS-write credentials for a module. A separate table from `providers`: a
 * domain's send path and its DNS write path are different blast radii and shouldn't share a
 * row. One per organization to start; nothing here stops a second.
 */
export const dnsProviderAccounts = pgTable(
  "dns_provider_accounts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** DNS provider module key, matching a file under lib/dns-providers. */
    module: text("module").notNull(),
    /** Unique per organization, across modules. */
    name: text("name").notNull(),
    /** AES-256-GCM ciphertext of the credentials JSON. */
    credentials: text("credentials").notNull(),
    /** Non-secret module config: an account id, a default zone id. */
    settings: jsonb("settings").$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("dns_provider_accounts_organization_idx").on(table.organizationId),
    unique("dns_provider_accounts_org_id_key").on(table.organizationId, table.id),
    uniqueIndex("dns_provider_accounts_name_idx").on(table.organizationId, table.name),
  ],
);

export type DnsProviderAccountRow = typeof dnsProviderAccounts.$inferSelect;
