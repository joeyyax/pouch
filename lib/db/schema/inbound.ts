import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { domains } from "./domains";
import { messages } from "./messages";
import type { InboundVerdicts } from "@/lib/providers/adapters/types";

/** One attachment on an inbound message. Content lives in object storage; this is its pointer. */
export interface InboundAttachment {
  filename: string;
  contentType: string;
  /** Decoded size, in bytes. */
  size: number;
  /** Object storage key under the "private" bucket, sealed with the row's body_key. Null when the message failed a virus scan and the content wasn't kept. */
  storageKey: string | null;
}

/**
 * Mail a domain received, normalized from whichever provider delivered it. Held for the
 * domain's retention window (`domains.inbound_retention_days`), then the whole row and its
 * objects are purged by the worker's inbound retention sweep — see worker/inbound-retention.ts.
 */
export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    /** Provider's own id for this inbound item, when it sends one. Null means it doesn't. */
    providerMessageId: text("provider_message_id"),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    /** Every recipient the provider named on the domain's inbound route. */
    to: text("to").array().notNull(),
    subject: text("subject").notNull().default(""),
    /** Plaintext from before bodies were sealed. Null on every row with a body_key. */
    text: text("text"),
    /** Plaintext from before bodies were sealed. Null on every row with a body_key. */
    html: text("html"),
    /** The per-message key sealing the body, attachments and raw message. Null on a legacy plaintext row or a quarantined one. */
    bodyKey: text("body_key"),
    /** Prefix of the message's objects in the "private" bucket; its body is `<storage_key>/body.json`. */
    storageKey: text("storage_key"),
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    /** The `Message-Id` header, verbatim. */
    messageId: text("message_id"),
    /** The `In-Reply-To` header, verbatim. Null when this isn't a reply to anything. */
    inReplyTo: text("in_reply_to"),
    /** Set when in_reply_to matches an outbound message's provider message id on this organization. */
    outboundMessageId: text("outbound_message_id").references(() => messages.id, { onDelete: "set null" }),
    attachments: jsonb("attachments").$type<InboundAttachment[]>().notNull().default([]),
    /** Object storage key of the message as received, under the "private" bucket. Null when the provider didn't hand it over. */
    rawStorageKey: text("raw_storage_key"),
    /** Addresses this message was delivered to. */
    addressIds: text("address_ids").array().notNull().default([]),
    /** Shared by every message linked through `Message-Id`, `In-Reply-To` and `References`. */
    threadId: text("thread_id").notNull(),
    /** The provider's scan results. Null when it doesn't scan. */
    verdicts: jsonb("verdicts").$type<InboundVerdicts>(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** received_at plus the domain's retention window, held to the install's ceiling, at the time this row was written. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("inbound_messages_organization_domain_idx").on(table.organizationId, table.domainId, table.receivedAt),
    index("inbound_messages_expires_idx").on(table.expiresAt),
    index("inbound_messages_received_idx").on(table.receivedAt),
    index("inbound_messages_in_reply_to_idx").on(table.organizationId, table.inReplyTo),
    index("inbound_messages_address_ids_idx").using("gin", table.addressIds),
    index("inbound_messages_thread_idx").on(table.organizationId, table.threadId),
    index("inbound_messages_outbound_message_idx").on(table.outboundMessageId),
    index("inbound_messages_message_key_idx").on(table.organizationId, sql`lower(btrim(${table.messageId}, '<> '))`),
    // A provider that retries its own delivery must land once, not duplicate the row.
    uniqueIndex("inbound_messages_provider_message_idx")
      .on(table.domainId, table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
  ],
);

export type InboundMessageRow = typeof inboundMessages.$inferSelect;
