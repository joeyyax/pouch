import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { domains } from "./domains";
import { providers } from "./providers";

/** The one row `dmarc_report_hosts` accepts. */
export const REPORT_HOST_ROW_ID = "service";

/** The service's report host: one row, set by an operator. No row, or a null host, means reports are off. */
export const dmarcReportHosts = pgTable(
  "dmarc_report_hosts",
  {
    id: text("id").primaryKey().default(REPORT_HOST_ROW_ID),
    host: text("host"),
    /** The provider that receives the host's mail. */
    providerId: text("provider_id").references(() => providers.id, { onDelete: "set null" }),
    /** What the provider's `inbound.open` returned, which `close` needs back. */
    route: jsonb("route").$type<Record<string, string>>(),
    /** When the host's records last checked out. Null until then, and after a check that doesn't. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("dmarc_report_hosts_singleton_check", sql`${table.id} = 'service'`)],
);

/** A domain's report address local part on the host. Opaque, so the address names no customer. */
export const dmarcDomainTokens = pgTable(
  "dmarc_domain_tokens",
  {
    domainId: text("domain_id")
      .primaryKey()
      .references(() => domains.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    /** When owners were emailed the `p=quarantine` record. Cleared once the published policy moves past none. */
    policyReadyNotifiedAt: timestamp("policy_ready_notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("dmarc_domain_tokens_token_idx").on(table.token)],
);

/** Who sent a report row's mail, as far as the domain's own records tell. */
export const DMARC_ORIGINS = ["provider", "other", "forwarded", "unauthenticated"] as const;
export type DmarcOrigin = (typeof DMARC_ORIGINS)[number];

export interface DmarcPublishedPolicy {
  domain: string;
  p: string | null;
  sp: string | null;
  pct: number | null;
  adkim: string | null;
  aspf: string | null;
}

export interface DmarcDkimResult {
  domain: string;
  selector: string | null;
  result: string;
}

export interface DmarcSpfResult {
  domain: string;
  scope: string | null;
  result: string;
}

/** One aggregate report a mailbox provider sent about a domain. Unique per domain, reporter and report id. */
export const dmarcReports = pgTable(
  "dmarc_reports",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    reporter: text("reporter").notNull(),
    reporterEmail: text("reporter_email"),
    reportId: text("report_id").notNull(),
    beginsAt: timestamp("begins_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    policy: jsonb("policy").$type<DmarcPublishedPolicy>().notNull(),
    messageCount: integer("message_count").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("dmarc_reports_unique_idx").on(table.domainId, table.reporter, table.reportId),
    index("dmarc_reports_domain_idx").on(table.organizationId, table.domainId, table.endsAt),
    index("dmarc_reports_received_idx").on(table.organizationId, table.receivedAt),
  ],
);

/** One row of a report: a source address and how its mail authenticated. */
export const dmarcReportRecords = pgTable(
  "dmarc_report_records",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    reportId: text("report_id")
      .notNull()
      .references(() => dmarcReports.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    /** The report's period end, copied so reads by window need no join. */
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    sourceIp: text("source_ip").notNull(),
    count: integer("count").notNull(),
    origin: text("origin").$type<DmarcOrigin>().notNull(),
    disposition: text("disposition").notNull(),
    /** The receiver's aligned verdicts, `pass` or `fail`. */
    dkim: text("dkim").notNull(),
    spf: text("spf").notNull(),
    headerFrom: text("header_from").notNull(),
    envelopeFrom: text("envelope_from"),
    dkimResults: jsonb("dkim_results").$type<DmarcDkimResult[]>().notNull().default([]),
    spfResults: jsonb("spf_results").$type<DmarcSpfResult[]>().notNull().default([]),
  },
  (table) => [
    index("dmarc_report_records_report_idx").on(table.reportId),
    index("dmarc_report_records_domain_idx").on(table.organizationId, table.domainId, table.endsAt),
    check("dmarc_report_records_origin_check", sql`${table.origin} in ('provider', 'other', 'forwarded', 'unauthenticated')`),
  ],
);

export type DmarcReportRow = typeof dmarcReports.$inferSelect;
export type DmarcReportRecordRow = typeof dmarcReportRecords.$inferSelect;
export type DmarcReportHostRow = typeof dmarcReportHosts.$inferSelect;
