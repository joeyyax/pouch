import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { DnsRecordType } from "@/lib/providers/adapters/types";
import { domains } from "./domains";
import { dnsProviderAccounts } from "./dns-provider-accounts";
import { organizations } from "./organizations";
import { providers } from "./providers";

/**
 * Provenance for every DNS record Pouch has written. Answers "is this ours" from a row, never
 * by guessing from shape — see docs/design/registrar-integration.md, "Provenance". For a merged
 * SPF record, `written_value` is the mechanisms Pouch added, not the whole record. Nothing is
 * ever deleted or edited from this table by this slice; #211 reads it to know what's safe to
 * remove.
 */
export const dnsProviderRecords = pgTable(
  "dns_provider_records",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    dnsProviderAccountId: text("dns_provider_account_id")
      .notNull()
      .references(() => dnsProviderAccounts.id, { onDelete: "restrict" }),
    zoneName: text("zone_name").notNull(),
    type: text("type").$type<DnsRecordType>().notNull(),
    name: text("name").notNull(),
    /** The exact value Pouch wrote — the whole record for a create, the mechanisms added for a merge. */
    writtenValue: text("written_value").notNull(),
    /**
     * The email provider whose requirements caused this row to exist — #239. Nullable:
     * rows written before this column existed have no way to know which provider they came from,
     * and `dns-cleanup.ts`'s `isCurrentlyRequired` inference is what still classifies those.
     */
    providerId: text("provider_id").references(() => providers.id, { onDelete: "set null" }),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("dns_provider_records_domain_idx").on(table.domainId),
    index("dns_provider_records_organization_idx").on(table.organizationId),
    index("dns_provider_records_lookup_idx").on(table.domainId, table.type, table.name),
    index("dns_provider_records_provider_idx").on(table.providerId),
  ],
);

export type DnsProviderRecordRow = typeof dnsProviderRecords.$inferSelect;
