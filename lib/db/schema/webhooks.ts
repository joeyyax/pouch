import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { apiKeys } from "./api-keys";
import { domains } from "./domains";
import { messages } from "./messages";
import { enumArrayCheck, enumCheck } from "./checks";
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "@/lib/webhooks/events";

export { WEBHOOK_EVENT_TYPES, KEY_WEBHOOK_EVENT_TYPES } from "@/lib/webhooks/events";
export type { WebhookEventType } from "@/lib/webhooks/events";

export const WEBHOOK_DELIVERY_STATUSES = ["pending", "succeeded", "failed", "exhausted"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Set on a key-scoped endpoint (dashboard, key detail page). Exactly one of this and domainId is set. */
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "cascade" }),
    /** Set on the one endpoint a domain registers to receive inbound.received (#6). */
    domainId: text("domain_id").references(() => domains.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    events: text("events").array().$type<WebhookEventType[]>().notNull(),
    description: text("description"),
    /** Signing secret, through encrypt() — recoverable so the worker can sign with it. */
    secretEncrypted: text("secret_encrypted").notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("webhook_endpoints_organization_idx").on(table.organizationId),
    index("webhook_endpoints_api_key_idx").on(table.apiKeyId),
    // A domain registers one inbound endpoint. Partial: an api-key-scoped row has a null domainId.
    uniqueIndex("webhook_endpoints_domain_unique_idx").on(table.domainId).where(sql`${table.domainId} is not null`),
    check("webhook_endpoints_events_check", enumArrayCheck(table.events, WEBHOOK_EVENT_TYPES)),
    // A key-scoped endpoint or a domain-scoped one, never both and never neither.
    check(
      "webhook_endpoints_owner_check",
      sql`(${table.apiKeyId} is null) <> (${table.domainId} is null)`,
    ),
  ],
);

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    eventType: text("event_type").$type<WebhookEventType>().notNull(),
    /** Frozen at enqueue. A retry sends exactly what the first attempt sent. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<WebhookDeliveryStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("webhook_deliveries_organization_idx").on(table.organizationId, table.createdAt),
    index("webhook_deliveries_endpoint_idx").on(table.endpointId, table.createdAt),
    index("webhook_deliveries_claim_idx").on(table.status, table.nextAttemptAt),
    check("webhook_deliveries_status_check", enumCheck(table.status, WEBHOOK_DELIVERY_STATUSES)),
    check("webhook_deliveries_event_type_check", enumCheck(table.eventType, WEBHOOK_EVENT_TYPES)),
  ],
);

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

export const webhookAttempts = pgTable(
  "webhook_attempts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => webhookDeliveries.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    statusCode: integer("status_code"),
    error: text("error"),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("webhook_attempts_delivery_idx").on(table.deliveryId, table.attempt)],
);
