import { sql } from "drizzle-orm";
import { type AnyPgColumn, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** One set of credentials for a provider adapter. Any number per adapter. */
export const providers = pgTable(
  "providers",
  {
    id: text("id").primaryKey(),
    /** Null means the row belongs to the service, not to an organization. Shared providers have none. */
    organizationId: text("organization_id").references((): AnyPgColumn => organizations.id, { onDelete: "cascade" }),
    /** Provider adapter key, matching a file under lib/providers/adapters. */
    adapter: text("adapter").notNull(),
    /** Unique per organization across adapters, and unique among shared providers. */
    name: text("name").notNull(),
    /** AES-256-GCM ciphertext of the credentials JSON. A assignment row carries a copy of its shared provider's. */
    credentials: text("credentials").notNull(),
    /** Non-secret provider config: configuration set names, topic ARNs, webhook public keys. */
    settings: jsonb("settings").$type<Record<string, string>>().notNull().default({}),
    /**
     * The provider's own identifier for the underlying provider behind these credentials — an AWS
     * provider id for SES, for instance. Two rows in different organizations can carry the same
     * value, which is the point: it's how the same reputation-bearing provider is recognized across
     * organizations. Null means the adapter has no such concept, or hasn't answered yet — never a
     * guess from the credentials themselves, and never treated as equal to another null.
     */
    providerIdentity: text("provider_identity"),
    /** An operator provider other organizations send through as tenants. Belongs to the service. */
    shared: boolean("shared").notNull().default(false),
    /** Set on an organization's assignment row: the shared provider it sends through. Managed by the operator. */
    sharedProviderId: text("shared_provider_id"),
    /** Concurrent sends allowed against this provider. */
    concurrency: integer("concurrency").notNull().default(16),
    /** Set when the provider asked for backoff. The worker skips the provider until it passes. */
    backoffUntil: timestamp("backoff_until", { withTimezone: true }),
    /**
     * When the provider's current, unbroken run of backoffs started. Set the first time a send
     * backs off after a clear provider, cleared the next time a send succeeds. Null means the
     * provider isn't backing off right now.
     */
    backingOffSince: timestamp("backing_off_since", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("providers_organization_idx").on(table.organizationId),
    unique("providers_org_id_key").on(table.organizationId, table.id),
    uniqueIndex("providers_name_idx").on(table.organizationId, table.name),
    // A shared provider has no organization, so the index above never compares two of them.
    uniqueIndex("providers_shared_name_idx").on(table.name).where(sql`${table.organizationId} is null`),
    // Groups providers by the real-world credentials behind them, across organizations. Partial:
    // a row with no known identity has nothing to group by, so it costs nothing to index.
    index("providers_identity_idx")
      .on(table.adapter, table.providerIdentity)
      .where(sql`${table.providerIdentity} is not null`),
    foreignKey({
      columns: [table.sharedProviderId],
      foreignColumns: [table.id],
      name: "providers_shared_provider_fk",
    }).onDelete("restrict"),
    uniqueIndex("providers_tenant_idx")
      .on(table.organizationId, table.sharedProviderId)
      .where(sql`${table.sharedProviderId} is not null`),
    check("providers_shared_check", sql`not (${table.shared} and ${table.sharedProviderId} is not null)`),
    check("providers_organization_check", sql`${table.shared} = (${table.organizationId} is null)`),
  ],
);
