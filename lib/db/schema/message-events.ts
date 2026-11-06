import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { messages, MESSAGE_STATUSES, type MessageStatus } from "./messages";
import { providers } from "./providers";
import { enumCheck, nullableEnumCheck } from "./checks";

/**
 * A transition is the message moving to a new state. The rest are occurrences: things that
 * happened to it without changing what it is.
 */
export const MESSAGE_EVENT_KINDS = [
  "transition",
  "retry",
  "backoff",
  "suppressed",
  "body_shredded",
  "webhook_delivered",
  "abandoned",
] as const;
export type MessageEventKind = (typeof MESSAGE_EVENT_KINDS)[number];

/** One row per thing that happened to a message, in the order it happened. */
export const messageEvents = pgTable(
  "message_events",
  {
    id: text("id").primaryKey(),
    /** Null on the service's own mail, like its message. */
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    kind: text("kind").$type<MessageEventKind>().notNull().default("transition"),
    /** The lifecycle status, on a transition. Null on every other kind. */
    status: text("status").$type<MessageStatus>(),
    /** The provider's reason, verbatim. */
    reason: text("reason"),
    /** SES's bounce type and subtype, as `Permanent/NoEmail`. Null for other providers and events. */
    bounceType: text("bounce_type"),
    /** The provider whose callback carried this event. Null on events the service raised itself. */
    providerId: text("provider_id"),
    /** The provider's own event id. Null on events the service raised itself. */
    providerEventId: text("provider_event_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("message_events_message_idx").on(table.messageId, table.occurredAt),
    index("message_events_organization_idx").on(table.organizationId),
    index("message_events_outcome_idx")
      .on(table.organizationId, table.occurredAt)
      .where(sql`${table.status} in ('bounced', 'complained')`),
    // A webhook retried by the provider applies once. Provider event ids are only unique
    // within a provider, so two providers of one adapter can reuse an id without colliding.
    uniqueIndex("message_events_provider_event_idx")
      .on(table.providerId, table.providerEventId)
      .where(sql`${table.providerEventId} is not null`),
    check("message_events_status_kind_check", sql`(${table.kind} = 'transition') = (${table.status} is not null)`),
    // A provider event with no provider would sit outside the dedupe index.
    check(
      "message_events_provider_event_provider_check",
      sql`${table.providerEventId} is null or ${table.providerId} is not null`,
    ),
    check("message_events_kind_check", enumCheck(table.kind, MESSAGE_EVENT_KINDS)),
    check("message_events_status_check", nullableEnumCheck(table.status, MESSAGE_STATUSES)),
    // Composite so an event can never name another organization's provider.
    foreignKey({
      columns: [table.organizationId, table.providerId],
      foreignColumns: [providers.organizationId, providers.id],
      name: "message_events_provider_fk",
    }).onDelete("restrict"),
  ],
);

export type MessageEventRow = typeof messageEvents.$inferSelect;

/** A transition row, where the status is the point of it. */
export type MessageTransitionRow = MessageEventRow & { status: MessageStatus };

export function isTransition(event: MessageEventRow): event is MessageTransitionRow {
  return event.kind === "transition" && event.status !== null;
}
