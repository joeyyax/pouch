import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { providers } from "./providers";
import { enumCheck, nullableEnumCheck } from "./checks";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import type { DomainLayout } from "@/lib/domains/layout";
import { STALL_REASONS, type StallDetail, type StallReason } from "@/lib/domains/guard";
import {
  INBOUND_RETENTION_DEFAULT_DAYS,
  INBOUND_RETENTION_HARD_MAX_DAYS,
  INBOUND_SUBDOMAIN_DEFAULT,
  INBOUND_SUBDOMAIN_PATTERN,
} from "@/lib/inbound/constants";

export const DOMAIN_STATUSES = ["pending", "verified", "failed"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export const domains = pgTable(
  "domains",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    name: text("name").notNull(),
    status: text("status").$type<DomainStatus>().notNull().default("pending"),
    /** Provider's own identifier for the domain. */
    providerDomainId: text("provider_domain_id"),
    /** DNS records the provider asked for, including MX rows for inbound. */
    dnsRecords: jsonb("dns_records").$type<ProposedDnsRecord[]>().notNull().default([]),
    /** Records the last answered check couldn't see. Empty on a verified domain. */
    missingRecords: jsonb("missing_records").$type<ProposedDnsRecord[]>().notNull().default([]),
    /** Logo, accent and footer a send with `layout: true` is wrapped in. Null means no frame. */
    layout: jsonb("layout").$type<DomainLayout | null>(),
    /** Whether this domain accepts mail. Requires a webhook — see lib/inbound/manage.ts. */
    inboundEnabled: boolean("inbound_enabled").notNull().default(false),
    /** Days inbound mail is held before the sweep purges it. 7 default, 30 max. */
    inboundRetentionDays: integer("inbound_retention_days").notNull().default(INBOUND_RETENTION_DEFAULT_DAYS),
    /** The label inbound mail lands on: `<label>.<name>`. */
    inboundSubdomain: text("inbound_subdomain").notNull().default(INBOUND_SUBDOMAIN_DEFAULT),
    /**
     * Non-secret, provider-specific config the inbound receiver needs to verify what this
     * domain's provider posts — Mailpace's per-domain Ed25519 webhook key, a Cloudflare Worker's
     * shared secret. Same shape as providers.settings, but scoped to the domain because
     * some of these providers key inbound verification per domain, not per provider.
     */
    inboundProviderSettings: jsonb("inbound_provider_settings").$type<Record<string, string>>().notNull().default({}),
    /**
     * Bulk mode (#7). When set, a bulk message's footer link points here with the unsubscribe
     * token as a query param instead of the hosted `/u/:token` page — see lib/bulk/headers.ts.
     * The hosted page stays the one-click `List-Unsubscribe-Post` target regardless.
     */
    unsubscribeUrl: text("unsubscribe_url"),
    /**
     * Bulk mode (#7). When set, a double opt-in confirmation email links here instead of the
     * hosted `/confirm` page, with the confirmation token as a query param.
     */
    confirmUrl: text("confirm_url"),
    /**
     * Explicit per-domain opt-in for bulk sending (#246). Default false — every existing domain
     * starts disabled, and an operator turns it on. A domain can only send bulk once this is
     * true and the provider adapter's own `capabilities.bulk` is too; turning it on is refused
     * outright when the provider can't do it (see lib/bulk/allowed.ts).
     */
    bulkAllowed: boolean("bulk_allowed").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** Provider reasons for a `failed` status. Cleared on the next verified answer. */
    verificationErrors: jsonb("verification_errors").$type<string[]>().notNull().default([]),
    /** Last time the verify loop asked the provider about this domain. */
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /**
     * Set by the stall guard (#94) when bounce or complaint activity crosses our own action
     * point. The worker stops releasing this domain's queued sends while it's set — nothing is
     * lost, and nothing new gets rejected either. Null clears only by a person; a rate recovering
     * because sending stopped isn't evidence the underlying problem is fixed.
     */
    stalledAt: timestamp("stalled_at", { withTimezone: true }),
    stallReason: text("stall_reason").$type<StallReason | null>(),
    /** The numbers that tripped it, snapshotted for the dashboard. Null once cleared. */
    stallDetail: jsonb("stall_detail").$type<StallDetail | null>(),
    /** Last time the stall guard evaluated this domain, stalled or not — drives its recheck order. */
    stallCheckedAt: timestamp("stall_checked_at", { withTimezone: true }),
    /**
     * Staged move to another provider (#35). Sending stays on `provider_id`
     * until this binding verifies; the worker's verify loop cuts it over on its own. Null means
     * no move is in progress.
     */
    pendingProviderId: text("pending_provider_id"),
    /** Provider's own identifier for the identity created at the pending provider. */
    pendingProviderDomainId: text("pending_provider_domain_id"),
    /** DNS records the pending provider asked for. */
    pendingDnsRecords: jsonb("pending_dns_records").$type<ProposedDnsRecord[]>().notNull().default([]),
    /** Records the last answered check on the pending provider couldn't see. */
    pendingMissingRecords: jsonb("pending_missing_records").$type<ProposedDnsRecord[]>().notNull().default([]),
    /** When this move was requested. Drives the pending-binding recheck schedule and its expiry. */
    pendingStartedAt: timestamp("pending_started_at", { withTimezone: true }),
    /** Last time the verify loop asked the pending provider about this move. */
    pendingLastCheckedAt: timestamp("pending_last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("domains_name_idx").on(table.organizationId, table.name),
    index("domains_provider_idx").on(table.providerId),
    index("domains_pending_provider_idx").on(table.pendingProviderId),
    check("domains_status_check", enumCheck(table.status, DOMAIN_STATUSES)),
    check("domains_stall_reason_check", nullableEnumCheck(table.stallReason, STALL_REASONS)),
    check("domains_stall_pairing_check", sql`(${table.stalledAt} is null) = (${table.stallReason} is null)`),
    check(
      "domains_inbound_retention_days_check",
      sql`${table.inboundRetentionDays} between 1 and ${sql.raw(String(INBOUND_RETENTION_HARD_MAX_DAYS))}`,
    ),
    check("domains_inbound_subdomain_check", sql`${table.inboundSubdomain} ~ ${sql.raw(`'${INBOUND_SUBDOMAIN_PATTERN.source}'`)}`),
    // Composite so a domain can never bind another organization's provider.
    foreignKey({
      columns: [table.organizationId, table.providerId],
      foreignColumns: [providers.organizationId, providers.id],
      name: "domains_provider_fk",
    }).onDelete("restrict"),
    // Same composite guard on the pending binding. Nullable, so it's inert until a move starts.
    foreignKey({
      columns: [table.organizationId, table.pendingProviderId],
      foreignColumns: [providers.organizationId, providers.id],
      name: "domains_pending_provider_fk",
    }).onDelete("restrict"),
  ],
);
