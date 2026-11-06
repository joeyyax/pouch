import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { apiKeys, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import type { MessageRow, WebhookEventType } from "@/lib/db/schema";
import { keyCanAccessDomain } from "@/lib/api/keys";
import { newId } from "@/lib/ids";
import { serializeMessage } from "@/lib/messages/serialize";
import { DELIVERY_EXPIRY_MS } from "./backoff";

/**
 * Enqueues one delivery per endpoint, given the endpoints already resolved and a frozen
 * payload. Shared tail end of both `enqueueWebhooks` (a message's own key) and
 * `enqueueDomainScopedWebhookEvent` (#7's list and unsubscribe events, which have no single
 * message to key off).
 */
async function enqueue(
  organizationId: string,
  endpointIds: string[],
  eventType: WebhookEventType,
  payload: Record<string, unknown>,
  messageId: string | null,
): Promise<number> {
  if (endpointIds.length === 0) return 0;

  const now = await dbNow();
  const expiresAt = new Date(now.getTime() + DELIVERY_EXPIRY_MS);

  await db.insert(webhookDeliveries).values(
    endpointIds.map((endpointId) => ({
      id: newId("webhookDelivery"),
      organizationId,
      endpointId,
      messageId,
      eventType,
      payload,
      status: "pending" as const,
      attempts: 0,
      nextAttemptAt: now,
      expiresAt,
    })),
  );

  return endpointIds.length;
}

export interface WebhookEventInput {
  /** The message_events row id this webhook reports. Becomes the payload's `id`. */
  eventId: string;
  eventType: WebhookEventType;
  occurredAt: Date;
  message: MessageRow;
}

/**
 * Enqueues one delivery per endpoint on the message's key that's subscribed to this event type.
 * Called from applyEvent after its transaction commits — enqueuing before commit would post an
 * event for a row that then rolled back. A key with no matching endpoint is a no-op.
 */
export async function enqueueWebhooks(organizationId: string, input: WebhookEventInput): Promise<number> {
  if (!input.message.apiKeyId) return 0;

  const endpoints = await db
    .select({ endpoint: webhookEndpoints })
    .from(webhookEndpoints)
    .innerJoin(apiKeys, eq(apiKeys.id, webhookEndpoints.apiKeyId))
    .where(
      and(
        eq(webhookEndpoints.organizationId, organizationId),
        eq(webhookEndpoints.apiKeyId, input.message.apiKeyId),
        isNull(webhookEndpoints.disabledAt),
        isNull(apiKeys.revokedAt),
      ),
    )
    .then((rows) => rows.map((row) => row.endpoint));

  const targets = endpoints.filter((endpoint) => endpoint.events.includes(input.eventType));

  const payload = {
    id: input.eventId,
    type: input.eventType,
    created_at: input.occurredAt.toISOString(),
    data: serializeMessage(input.message),
  };

  return enqueue(
    organizationId,
    targets.map((endpoint) => endpoint.id),
    input.eventType,
    payload,
    input.message.id,
  );
}

export interface DomainScopedWebhookEventInput {
  eventId: string;
  eventType: WebhookEventType;
  occurredAt: Date;
  domainId: string;
  /** The message shape a receiver already knows how to parse; never a raw message row. */
  data: Record<string, unknown>;
}

/**
 * Enqueues `email.unsubscribed` and `list.subscribed` (#7) — events with no single message
 * behind them, so unlike `enqueueWebhooks` there's no api key to read off a row. Every key in
 * the organization whose scope reaches the domain, and whose endpoints subscribe to the event
 * type, gets a delivery — the same domain-scoping rule `GET /v1/events` applies.
 */
export async function enqueueDomainScopedWebhookEvent(
  organizationId: string,
  input: DomainScopedWebhookEventInput,
): Promise<number> {
  const rows = await db
    .select({ endpoint: webhookEndpoints, domainIds: apiKeys.domainIds })
    .from(webhookEndpoints)
    .innerJoin(apiKeys, eq(apiKeys.id, webhookEndpoints.apiKeyId))
    .where(and(eq(webhookEndpoints.organizationId, organizationId), isNull(webhookEndpoints.disabledAt), isNull(apiKeys.revokedAt)));

  const targets = rows
    .filter((row) => row.endpoint.events.includes(input.eventType))
    .filter((row) => keyCanAccessDomain({ domainIds: row.domainIds }, input.domainId))
    .map((row) => row.endpoint.id);

  const payload = {
    id: input.eventId,
    type: input.eventType,
    created_at: input.occurredAt.toISOString(),
    data: input.data,
  };

  return enqueue(organizationId, [...new Set(targets)], input.eventType, payload, null);
}

export interface OrganizationWebhookEventInput {
  eventId: string;
  eventType: WebhookEventType;
  occurredAt: Date;
  data: Record<string, unknown>;
}

/** Organization-wide events go only to keys scoped to every domain, since they summarize all of them. */
export async function enqueueOrganizationWebhookEvent(organizationId: string, input: OrganizationWebhookEventInput): Promise<number> {
  const rows = await db
    .select({ endpoint: webhookEndpoints, domainIds: apiKeys.domainIds })
    .from(webhookEndpoints)
    .innerJoin(apiKeys, eq(apiKeys.id, webhookEndpoints.apiKeyId))
    .where(and(eq(webhookEndpoints.organizationId, organizationId), isNull(webhookEndpoints.disabledAt), isNull(apiKeys.revokedAt)));

  const targets = rows
    .filter((row) => row.endpoint.events.includes(input.eventType) && row.domainIds.length === 0)
    .map((row) => row.endpoint.id);

  const payload = {
    id: input.eventId,
    type: input.eventType,
    created_at: input.occurredAt.toISOString(),
    data: input.data,
  };

  return enqueue(organizationId, targets, input.eventType, payload, null);
}
