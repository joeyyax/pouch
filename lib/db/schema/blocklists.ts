import { check, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { BLOCKLISTS, type BlocklistId } from "@/lib/blocklists/lists";
import { organizations } from "./organizations";
import { domains } from "./domains";
import { enumCheck, nullableEnumCheck } from "./checks";

export const BLOCKLIST_STATUSES = ["clear", "listed"] as const;
export type BlocklistStatusValue = (typeof BLOCKLIST_STATUSES)[number];

/** The last answer each list gave for a sending domain. */
export const domainBlocklistChecks = pgTable(
  "domain_blocklist_checks",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    list: text("list").$type<BlocklistId>().notNull(),
    /** Null until a list has answered. */
    status: text("status").$type<BlocklistStatusValue | null>(),
    /** The list's return code while listed. */
    code: text("code"),
    reason: text("reason"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    listedSince: timestamp("listed_since", { withTimezone: true }),
    /** When a listing lapses on its own, as ZRD's do. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** The last check that got no answer, kept apart from the last answer. */
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.domainId, table.list] }),
    index("domain_blocklist_checks_organization_idx").on(table.organizationId),
    check("domain_blocklist_checks_list_check", enumCheck(table.list, BLOCKLISTS)),
    check("domain_blocklist_checks_status_check", nullableEnumCheck(table.status, BLOCKLIST_STATUSES)),
  ],
);

export type DomainBlocklistCheckRow = typeof domainBlocklistChecks.$inferSelect;
