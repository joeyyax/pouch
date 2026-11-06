import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { domains } from "./domains";
import { apiKeys } from "./api-keys";
import { providers } from "./providers";
import { enumCheck } from "./checks";
import type { LayoutOverrides } from "@/lib/domains/layout";
import type { BlocklistId } from "@/lib/blocklists/lists";
import { MESSAGE_STATUSES } from "../enums";

export { MESSAGE_STATUSES };
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** A recipient's history worth flagging. Never changes whether the message is accepted. */
export type MessageWarningCode = "previously_bounced" | "previously_complained" | "frequent_deferrals";

export interface MessageWarning {
  code: MessageWarningCode;
  address: string;
  message: string;
  detail: Record<string, unknown>;
}

/** A domain the html linked to that a blocklist had listed when the message sent. */
export interface LinkListing {
  domain: string;
  list: BlocklistId;
  code: string;
  reason: string;
}

/** Recipients and headers as accepted. The body and attachments live in object storage. */
export interface MessageEnvelope {
  from: string;
  fromName: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  headers: Record<string, string>;
  attachmentCount: number;
}

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    /** Null for the service's own mail. Its domain names the organization whose provider carries it. */
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    /** Set on a bulk send (#7) — one row per recipient of a POST /v1/batches call. Null for a plain send. */
    batchId: text("batch_id"),
    status: text("status").$type<MessageStatus>().notNull().default("queued"),
    /** Normalized sender address. */
    fromAddress: text("from_address").notNull(),
    /** Every normalized recipient across to, cc and bcc. Suppression and purge match on these. */
    recipients: text("recipients").array().notNull(),
    subject: text("subject").notNull(),
    envelope: jsonb("envelope").$type<MessageEnvelope>().notNull(),
    tags: text("tags").array().notNull().default([]),
    /** Recipient-history hints as they stood at accept time. Snapshot, not recomputed later. */
    warnings: jsonb("warnings").$type<MessageWarning[]>().notNull().default([]),
    /** Object storage prefix holding the body and attachments. */
    storageKey: text("storage_key"),
    /** UTF-8 bytes of the html and text parts as accepted. Null before sizes were recorded. */
    bodyBytes: integer("body_bytes"),
    /** Decoded attachment bytes as accepted; 0 with none. Null before sizes were recorded. */
    attachmentBytes: integer("attachment_bytes"),
    /** Base64 of 32 random bytes used to encrypt the body. Null once the retention sweep shreds it. */
    bodyKey: text("body_key"),
    /** The message this one was resent from. Null for an original send. */
    resentFrom: text("resent_from").references((): AnyPgColumn => messages.id, { onDelete: "set null" }),
    /** Set when a test-mode key accepted the send. */
    testMode: boolean("test_mode").notNull().default(false),
    /** Whether the send asked to be wrapped in the domain's layout. */
    layout: boolean("layout").notNull().default(false),
    /**
     * Fields this send overrode on the domain's layout, applied on top of it at render time.
     * Null on a plain `layout: true` send. Kept on the row rather than recomputed from the
     * domain's current layout, so the dashboard shows the frame as it was sent even after the
     * domain's layout changes.
     */
    layoutOverrides: jsonb("layout_overrides").$type<LayoutOverrides | null>(),
    /** The provider that produced `provider_message_id`. Written with it, at send. */
    providerId: text("provider_id"),
    providerMessageId: text("provider_message_id"),
    /** Last provider reason, verbatim. */
    failureReason: text("failure_reason"),
    attempts: integer("attempts").notNull().default(0),
    /** Set right before each provider call, ahead of the outcome. Shows a crash mid-call on reclaim. */
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    /** Earliest time the worker may claim this row. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set while a worker holds the row. */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    /**
     * The `X-Request-Id` of the call that accepted this message, so every worker line about it
     * carries the id the caller holds. Null for a send with no request behind it — SMTP, a
     * system mail, a list confirmation.
     */
    requestId: text("request_id"),
    idempotencyKey: text("idempotency_key"),
    /** SHA-256 of the canonical request body, compared on an idempotency replay. */
    requestHash: text("request_hash"),
    /**
     * SHA-256 of the rendered body — html after layout wrapping, plus text. Not the same thing
     * as request_hash: two requests with different subjects or headers land here identically
     * when the mail body itself would render the same, which is the bulk-detection signal.
     */
    bodyHash: text("body_hash"),
    /** Listed link domains found at send. Null when none were, or they weren't checked. */
    linkListings: jsonb("link_listings").$type<LinkListing[] | null>(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /**
     * Set by the abandon sweep when a `sent` message has gone past ABANDON_MS with no terminal
     * event — the provider took it and will never report back. `status` stays `sent`: this is a
     * marker, not a new lifecycle state. See worker/abandon.ts.
     */
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    /** What the body carried, when it held a credential: "a sign-in link". Reads show the reason, never the body, and the sweep shreds the key once sent. */
    bodyWithheld: text("body_withheld"),
    /** Set when the body is purged from object storage. */
    bodyPurgedAt: timestamp("body_purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("messages_organization_created_idx").on(table.organizationId, table.createdAt),
    index("messages_status_next_attempt_idx").on(table.status, table.nextAttemptAt),
    // The abandon sweep's own lookup: sent, unmarked, old.
    index("messages_status_sent_idx").on(table.status, table.sentAt),
    index("messages_domain_idx").on(table.domainId),
    // The copies resent from a message.
    index("messages_resent_from_idx")
      .on(table.resentFrom)
      .where(sql`${table.resentFrom} is not null`),
    // GET /v1/batches/:id's message list and status counts.
    index("messages_batch_idx").on(table.batchId),
    // Provider ids are only unique within a provider, so an event resolves on the provider too.
    index("messages_provider_message_idx").on(table.organizationId, table.providerId, table.providerMessageId),
    index("messages_recipients_idx").using("gin", table.recipients),
    // The dashboard card that names the messages behind a fan-out hold reads this.
    index("messages_api_key_body_hash_idx").on(table.apiKeyId, table.bodyHash),
    index("messages_tags_idx").using("gin", table.tags),
    // The system screen's unconfirmed count: marks in a window, grouped by provider.
    index("messages_abandoned_at_idx")
      .on(table.abandonedAt, table.providerId)
      .where(sql`${table.abandonedAt} is not null`),
    // Its denominator: every send in a window, whatever the status ended up being.
    index("messages_sent_at_idx").on(table.sentAt),
    // The stats rollup's lookup: hours holding a message that changed since its last run.
    index("messages_updated_at_idx").on(table.updatedAt),
    // Sensitive mail: the list filter, the overview's share and the per-address count on a message.
    index("messages_withheld_idx")
      .on(table.organizationId, table.createdAt)
      .where(sql`${table.bodyWithheld} is not null`),
    // Per-tag daily counts for the tag_quiet observation: live, tagged mail only.
    index("messages_live_tagged_idx")
      .on(table.organizationId, table.createdAt)
      .where(sql`${table.testMode} = false and cardinality(${table.tags}) > 0`),
    index("messages_link_listings_idx")
      .on(table.organizationId, table.sentAt)
      .where(sql`${table.linkListings} is not null`),
    uniqueIndex("messages_idempotency_idx")
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    uniqueIndex("messages_service_idempotency_idx")
      .on(table.idempotencyKey)
      .where(sql`${table.organizationId} is null and ${table.idempotencyKey} is not null`),
    // Admin's service mail list.
    index("messages_service_created_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.organizationId} is null`),
    // Composite so a message can never name another organization's provider.
    foreignKey({
      columns: [table.organizationId, table.providerId],
      foreignColumns: [providers.organizationId, providers.id],
      name: "messages_provider_fk",
    }).onDelete("restrict"),
    check("messages_status_check", enumCheck(table.status, MESSAGE_STATUSES)),
  ],
);

export type MessageRow = typeof messages.$inferSelect;

/** A message an organization holds, which every organization-scoped read returns. */
export type OwnedMessageRow = MessageRow & { organizationId: string };