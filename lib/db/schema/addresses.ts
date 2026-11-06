import { check, date, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { domains } from "./domains";
import { apiKeys } from "./api-keys";
import { enumCheck } from "./checks";
import { ADDRESS_STATUSES, type AddressStatus } from "@/lib/addresses/constants";

export { ADDRESS_STATUSES, type AddressStatus } from "@/lib/addresses/constants";

/** A programmable address on a domain's inbound host. Mail to it is routed in lib/addresses/route.ts. */
export const addresses = pgTable(
  "addresses",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    /** The key that created it. Its endpoints receive `address.received`. */
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    /** Lowercased. Held for the life of the row, so a revoked address is never reissued. */
    localPart: text("local_part").notNull(),
    label: text("label"),
    /** Kept current by the expiry sweep. Routing checks `expires_at` itself. */
    status: text("status").$type<AddressStatus>().notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Lifetime cap on delivered messages. Null means none. */
    messageCap: integer("message_cap"),
    receivedCount: integer("received_count").notNull().default(0),
    droppedExpiredCount: integer("dropped_expired_count").notNull().default(0),
    droppedOverLimitCount: integer("dropped_over_limit_count").notNull().default(0),
    droppedVirusCount: integer("dropped_virus_count").notNull().default(0),
    /** Copies sent on to forward targets. */
    forwardedCount: integer("forwarded_count").notNull().default(0),
    /** Delivered on `received_day` (UTC), for the organization's daily limit. */
    receivedToday: integer("received_today").notNull().default(0),
    receivedDay: date("received_day"),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("addresses_domain_local_part_idx").on(table.domainId, table.localPart),
    index("addresses_organization_idx").on(table.organizationId, table.createdAt),
    index("addresses_status_expires_idx").on(table.status, table.expiresAt),
    check("addresses_status_check", enumCheck(table.status, ADDRESS_STATUSES)),
  ],
);

export type AddressRow = typeof addresses.$inferSelect;
