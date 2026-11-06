import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations";
import { addresses } from "./addresses";
import { inboundMessages } from "./inbound";
import { messages } from "./messages";
import { enumCheck, nullableEnumCheck } from "./checks";
import {
  FORWARD_DISABLED_REASONS,
  FORWARD_STATUSES,
  FORWARD_TARGET_STATUSES,
  type ForwardDisabledReason,
  type ForwardStatus,
  type ForwardTargetStatus,
} from "@/lib/addresses/constants";

export interface ForwardFailure {
  code: string;
  message: string;
  at: string;
}

/** A mailbox an address forwards to, once the mailbox confirms by link. */
export const addressForwardTargets = pgTable(
  "address_forward_targets",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    addressId: text("address_id")
      .notNull()
      .references(() => addresses.id, { onDelete: "cascade" }),
    /** Domain part lowercased, local part kept. */
    email: text("email").notNull(),
    status: text("status").$type<ForwardTargetStatus>().notNull().default("pending"),
    /** SHA-256 of the confirmation token, kept once confirmed so the link can say so. Null once disabled. */
    tokenHash: text("token_hash"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    confirmationSentAt: timestamp("confirmation_sent_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason").$type<ForwardDisabledReason>(),
    forwardedCount: integer("forwarded_count").notNull().default(0),
    lastForwardedAt: timestamp("last_forwarded_at", { withTimezone: true }),
    lastFailure: jsonb("last_failure").$type<ForwardFailure>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("address_forward_targets_address_email_idx").on(table.addressId, sql`lower(${table.email})`),
    uniqueIndex("address_forward_targets_token_idx").on(table.tokenHash).where(sql`${table.tokenHash} is not null`),
    index("address_forward_targets_organization_idx").on(table.organizationId, table.status),
    check("address_forward_targets_status_check", enumCheck(table.status, FORWARD_TARGET_STATUSES)),
    check("address_forward_targets_disabled_reason_check", nullableEnumCheck(table.disabledReason, FORWARD_DISABLED_REASONS)),
  ],
);

export type AddressForwardTargetRow = typeof addressForwardTargets.$inferSelect;

/** One inbound message forwarded to one target, and the outbound message that carried it. */
export const addressForwards = pgTable(
  "address_forwards",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    addressId: text("address_id")
      .notNull()
      .references(() => addresses.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => addressForwardTargets.id, { onDelete: "cascade" }),
    inboundMessageId: text("inbound_message_id")
      .notNull()
      .references(() => inboundMessages.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    status: text("status").$type<ForwardStatus>().notNull().default("pending"),
    /** Why it failed or was skipped: an API error code, or the state that stopped it. */
    reason: text("reason"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("address_forwards_message_target_idx").on(table.inboundMessageId, table.targetId),
    index("address_forwards_pending_idx").on(table.createdAt).where(sql`${table.status} = 'pending'`),
    index("address_forwards_message_idx").on(table.messageId),
    check("address_forwards_status_check", enumCheck(table.status, FORWARD_STATUSES)),
  ],
);

export type AddressForwardRow = typeof addressForwards.$inferSelect;
