/**
 * The shapes the webhooks screen renders, and the pure helpers it calls.
 *
 * lib/dashboard/views is the client boundary: every value a screen needs at runtime lives here,
 * and nothing under it imports a module that reaches Postgres, object storage or Redis. A value
 * imported from one of those into a "use client" file drags the Postgres driver into the browser
 * bundle — which typecheck and lint both allow, and only the browser catches. Types are erased,
 * so a client component may still import one from a loader.
 */
import type { WebhookDeliveryStatus } from "@/lib/db/schema";
import type { WebhookEventType } from "@/lib/webhooks/events";

export { WEBHOOK_EVENT_TYPES, KEY_WEBHOOK_EVENT_TYPES } from "@/lib/webhooks/events";
export type { WebhookEventType } from "@/lib/webhooks/events";

export interface WebhookEndpointView {
  id: string;
  url: string;
  events: WebhookEventType[];
  description: string | null;
  disabled: boolean;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdAt: Date;
}

export interface WebhookDeliveryView {
  id: string;
  eventType: WebhookEventType;
  status: WebhookDeliveryStatus;
  attempts: number;
  /** Null unless pending. */
  nextAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: Date;
}

export interface WebhookAttemptView {
  attempt: number;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
  createdAt: Date;
}

/** What the delivery dialog loads on open. */
export interface WebhookDeliveryDetailView {
  payload: Record<string, unknown>;
  attempts: WebhookAttemptView[];
}
