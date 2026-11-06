/**
 * A key-scoped endpoint's delivery log, defined once for `/v1/webhook_endpoints/:id/deliveries`,
 * the MCP tools over it and the key detail screen. A stored payload is what was posted; the
 * inbound sweep nulls the body in it when the message goes (`lib/inbound/payloads.ts`).
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { webhookAttempts, webhookDeliveries, type WebhookDeliveryRow, type WebhookDeliveryStatus } from "@/lib/db/schema";
import type { WebhookEventType } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { keysetBefore } from "@/lib/db/keyset";
import { endpointRow, type WebhookCaller } from "./manage";

export interface SerializedWebhookAttempt {
  id: string;
  attempt: number;
  status_code: number | null;
  error: string | null;
  duration_ms: number;
  created_at: string;
}

export interface SerializedWebhookDelivery {
  id: string;
  endpoint_id: string;
  event_type: WebhookEventType;
  status: WebhookDeliveryStatus;
  attempt_count: number;
  last_status_code: number | null;
  last_error: string | null;
  /** Null unless pending: the column keeps the last claim once nothing is scheduled. */
  next_attempt_at: string | null;
  succeeded_at: string | null;
  expires_at: string;
  message_id: string | null;
  created_at: string;
  /** With `include=payload`. */
  payload?: Record<string, unknown>;
  /** With `include=attempts`. */
  attempts?: SerializedWebhookAttempt[];
}

export interface WebhookDeliveryPage {
  data: SerializedWebhookDelivery[];
  next_cursor: string | null;
}

export interface DeliveryParts {
  payload?: boolean;
  attempts?: boolean;
}

/** Every column but the payload, which only loads when asked for. */
const BASE_COLUMNS = {
  id: webhookDeliveries.id,
  endpointId: webhookDeliveries.endpointId,
  eventType: webhookDeliveries.eventType,
  status: webhookDeliveries.status,
  attempts: webhookDeliveries.attempts,
  lastStatusCode: webhookDeliveries.lastStatusCode,
  lastError: webhookDeliveries.lastError,
  nextAttemptAt: webhookDeliveries.nextAttemptAt,
  succeededAt: webhookDeliveries.succeededAt,
  expiresAt: webhookDeliveries.expiresAt,
  messageId: webhookDeliveries.messageId,
  createdAt: webhookDeliveries.createdAt,
};

type DeliveryColumns = Omit<WebhookDeliveryRow, "organizationId" | "payload" | "lockedAt" | "lockedBy"> & {
  payload?: Record<string, unknown>;
};

function serializeAttempt(row: typeof webhookAttempts.$inferSelect): SerializedWebhookAttempt {
  return {
    id: row.id,
    attempt: row.attempt,
    status_code: row.statusCode,
    error: row.error,
    duration_ms: row.durationMs,
    created_at: row.createdAt.toISOString(),
  };
}

export function serializeDelivery(row: DeliveryColumns, attempts?: SerializedWebhookAttempt[]): SerializedWebhookDelivery {
  return {
    id: row.id,
    endpoint_id: row.endpointId,
    event_type: row.eventType,
    status: row.status,
    attempt_count: row.attempts,
    last_status_code: row.lastStatusCode,
    last_error: row.lastError,
    next_attempt_at: row.status === "pending" ? row.nextAttemptAt.toISOString() : null,
    succeeded_at: row.succeededAt?.toISOString() ?? null,
    expires_at: row.expiresAt.toISOString(),
    message_id: row.messageId,
    created_at: row.createdAt.toISOString(),
    ...(row.payload !== undefined ? { payload: row.payload } : {}),
    ...(attempts ? { attempts } : {}),
  };
}

/** Attempts for each delivery, oldest first, in one read. */
async function attemptsFor(organizationId: string, deliveryIds: string[]): Promise<Map<string, SerializedWebhookAttempt[]>> {
  const byDelivery = new Map<string, SerializedWebhookAttempt[]>(deliveryIds.map((id) => [id, []]));
  if (deliveryIds.length === 0) return byDelivery;
  const rows = await db
    .select()
    .from(webhookAttempts)
    .where(and(eq(webhookAttempts.organizationId, organizationId), inArray(webhookAttempts.deliveryId, deliveryIds)))
    .orderBy(asc(webhookAttempts.deliveryId), asc(webhookAttempts.attempt));
  for (const row of rows) byDelivery.get(row.deliveryId)?.push(serializeAttempt(row));
  return byDelivery;
}

function columns(parts: DeliveryParts) {
  return parts.payload ? { ...BASE_COLUMNS, payload: webhookDeliveries.payload } : BASE_COLUMNS;
}

/** One endpoint's deliveries, newest first. */
export async function listWebhookDeliveries(
  caller: WebhookCaller,
  endpointId: string,
  limit: number,
  cursor: string | undefined,
  parts: DeliveryParts = {},
): Promise<WebhookDeliveryPage> {
  await endpointRow(caller, endpointId);
  const rows: DeliveryColumns[] = await db
    .select(columns(parts))
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.organizationId, caller.organizationId),
        eq(webhookDeliveries.endpointId, endpointId),
        cursor ? keysetBefore({ table: webhookDeliveries, sort: webhookDeliveries.createdAt, id: webhookDeliveries.id }, cursor) : undefined,
      ),
    )
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const attempts = parts.attempts ? await attemptsFor(caller.organizationId, page.map((row) => row.id)) : null;
  return {
    data: page.map((row) => serializeDelivery(row, attempts?.get(row.id))),
    next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function readWebhookDelivery(
  caller: WebhookCaller,
  endpointId: string,
  deliveryId: string,
  parts: DeliveryParts = {},
): Promise<SerializedWebhookDelivery> {
  await endpointRow(caller, endpointId);
  const [row] = (await db
    .select(columns(parts))
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.organizationId, caller.organizationId),
        eq(webhookDeliveries.endpointId, endpointId),
        eq(webhookDeliveries.id, deliveryId),
      ),
    )
    .limit(1)) as DeliveryColumns[];
  if (!row) throw new ApiError("not_found", `No webhook delivery with id ${deliveryId}.`);
  const attempts = parts.attempts ? (await attemptsFor(caller.organizationId, [row.id])).get(row.id) : undefined;
  return serializeDelivery(row, attempts);
}

/**
 * The newest delivery of each inbound message to its domain's endpoint, keyed by message id. A
 * message with none is absent. A domain endpoint isn't a key-scoped one, so this reads by the
 * message id inside the payload rather than through an endpoint.
 */
export async function latestInboundDeliveries(
  organizationId: string,
  received: { id: string; receivedAt: Date }[],
): Promise<Record<string, SerializedWebhookDelivery>> {
  if (received.length === 0) return {};
  // A delivery is never older than its message, so receivedAt bounds the scan on the organization index.
  const since = new Date(Math.min(...received.map((message) => message.receivedAt.getTime())));
  const ids = sql.join(received.map((message) => sql`${message.id}`), sql`, `);
  const rows = await db
    .selectDistinctOn([sql`${webhookDeliveries.payload}->'data'->>'id'`], { inboundId: sql<string>`${webhookDeliveries.payload}->'data'->>'id'`, ...BASE_COLUMNS })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.organizationId, organizationId),
        eq(webhookDeliveries.eventType, "inbound.received"),
        sql`${webhookDeliveries.createdAt} >= ${since.toISOString()}::timestamptz`,
        sql`${webhookDeliveries.payload}->'data'->>'id' in (${ids})`,
      ),
    )
    .orderBy(sql`${webhookDeliveries.payload}->'data'->>'id'`, desc(webhookDeliveries.createdAt));
  return Object.fromEntries(rows.map(({ inboundId, ...row }) => [inboundId, serializeDelivery(row)]));
}
