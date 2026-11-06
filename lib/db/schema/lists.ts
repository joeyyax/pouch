import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { domains } from "./domains";
import { apiKeys } from "./api-keys";
import { messages } from "./messages";
import { enumCheck } from "./checks";
import { MEMBERSHIP_STATUSES } from "../enums";

/**
 * Bulk mode (#7). A list is a named set of addresses per domain. Lists never grow from a
 * transactional send without `subscribe`; every membership records where it came from.
 */
export const lists = pgTable(
  "lists",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /** Default true. A new membership is `pending` until it confirms. See list-memberships. */
    doubleOptIn: boolean("double_opt_in").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lists_domain_name_idx").on(table.domainId, table.name),
    index("lists_organization_idx").on(table.organizationId),
  ],
);

export type ListRow = typeof lists.$inferSelect;

export { MEMBERSHIP_STATUSES };
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const MEMBERSHIP_SOURCES = ["api", "import", "manual"] as const;
export type MembershipSource = (typeof MEMBERSHIP_SOURCES)[number];

/** Which opt-in mode confirmed a membership, so "who confirmed this" stays answerable later. */
export const CONFIRMED_BY_VALUES = ["link", "import", "not_required"] as const;
export type ConfirmedBy = (typeof CONFIRMED_BY_VALUES)[number];

/** A flat attribute map substituted into `{{name}}` placeholders on a batch send. */
export type ListMemberAttributes = Record<string, string>;

export const listMemberships = pgTable(
  "list_memberships",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    listId: text("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    /** Normalized: domain part lowercased, local part preserved. */
    address: text("address").notNull(),
    status: text("status").$type<MembershipStatus>().notNull().default("pending"),
    source: text("source").$type<MembershipSource>().notNull(),
    /** Set when source is "api" — the send whose `subscribe` added this member. */
    sourceMessageId: text("source_message_id").references(() => messages.id, { onDelete: "set null" }),
    /** Set when source is "manual" — who added the member, from the recipients view. */
    manualActor: text("manual_actor"),
    attributes: jsonb("attributes").$type<ListMemberAttributes>().notNull().default({}),
    /** The opt-in mode that applied to this membership, copied from the list at creation time. */
    doubleOptIn: boolean("double_opt_in").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by").$type<ConfirmedBy | null>(),
    /** Set on a pending membership: 7 days out. A pending row past this never receives a batch. */
    pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true }),
    /** Set once the confirmation email has been queued, so the worker sends it exactly once. */
    confirmationSentAt: timestamp("confirmation_sent_at", { withTimezone: true }),
    /**
     * Sends attempted for this membership's confirmation. A send that fails leaves
     * `confirmation_sent_at` null so it can be retried, which without a counter means an
     * address that can never be sent to is retried every ten seconds for as long as the row
     * exists, holding a place in every batch.
     */
    confirmationAttempts: integer("confirmation_attempts").notNull().default(0),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("list_memberships_list_address_idx").on(table.listId, table.address),
    index("list_memberships_organization_idx").on(table.organizationId),
    index("list_memberships_list_status_idx").on(table.listId, table.status),
    index("list_memberships_pending_expiry_idx").on(table.status, table.pendingExpiresAt),
    index("list_memberships_confirmation_due_idx").on(
      table.status,
      table.doubleOptIn,
      table.confirmationSentAt,
      table.confirmationAttempts,
      table.createdAt,
    ),
    check("list_memberships_status_check", enumCheck(table.status, MEMBERSHIP_STATUSES)),
    check("list_memberships_source_check", enumCheck(table.source, MEMBERSHIP_SOURCES)),
  ],
);

export type ListMembershipRow = typeof listMemberships.$inferSelect;

/**
 * One `POST /v1/batches` call. The messages it produced carry `batch_id` — see
 * `messages.batchId` — and their statuses are what `GET /v1/batches/:id` counts; this row
 * holds only what the send itself decided, not a rollup that would drift from the messages.
 */
export const batches = pgTable(
  "batches",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    /** Set when the batch drew its recipients from a list. Null for inline `recipients`. */
    listId: text("list_id").references(() => lists.id, { onDelete: "set null" }),
    fromAddress: text("from_address").notNull(),
    subject: text("subject").notNull(),
    tags: text("tags").array().notNull().default([]),
    /** Recipients that became a message. */
    recipientCount: integer("recipient_count").notNull(),
    /** Recipients skipped because they were unsubscribed (list or domain) or not yet confirmed. */
    skippedCount: integer("skipped_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("batches_organization_created_idx").on(table.organizationId, table.createdAt),
    index("batches_domain_idx").on(table.domainId),
  ],
);

export type BatchRow = typeof batches.$inferSelect;

/**
 * "Stop all mail from this domain" — the one-link option next to a list unsubscribe.
 * Deliberately its own table, not folded into `suppressions`: a suppression is a delivery
 * failure signal (hard bounce, complaint) that blocks every domain; this is a recipient's own
 * choice, scoped to one domain, and the dashboard has to say which of the two applied.
 */
export const domainUnsubscribes = pgTable(
  "domain_unsubscribes",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("domain_unsubscribes_domain_address_idx").on(table.domainId, table.address),
    index("domain_unsubscribes_organization_idx").on(table.organizationId),
  ],
);
