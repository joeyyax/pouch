/**
 * Key-scoped webhook endpoints, defined once for every surface: `/v1/webhook_endpoints`, the
 * MCP tools over it and the key detail screen's server actions. A domain's inbound endpoint is
 * a different thing with a different door — `PATCH /v1/domains/:id/inbound`.
 */
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, webhookEndpoints, type WebhookEndpointRow, type WebhookEventType } from "@/lib/db/schema";
import type { KeyMode } from "@/lib/api/keys";
import { keysetBefore } from "@/lib/db/keyset";
import { ApiError } from "@/lib/api/errors";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import type { CreateWebhookEndpointRequest, UpdateWebhookEndpointRequest } from "@/lib/schemas/webhook-endpoint";
import {
  createEndpoint,
  deleteEndpoint,
  rotateSecret,
  setDisabled,
  updateEndpoint,
} from "./endpoints";

/** Who is asking. An API key and a dashboard session differ only in what they're limited to. */
export interface WebhookCaller {
  organizationId: string;
  /** Domains the caller is limited to. Empty means every domain. */
  domainIds: string[];
  actor: ActivityActor;
  /** Set for an API key caller: the mode of the keys whose endpoints it may manage. */
  mode?: KeyMode;
}

export interface SerializedWebhookEndpoint {
  id: string;
  key_id: string;
  url: string;
  events: WebhookEventType[];
  description: string | null;
  disabled: boolean;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
}

export interface WebhookEndpointPage {
  data: SerializedWebhookEndpoint[];
  next_cursor: string | null;
}

export function serializeEndpoint(row: WebhookEndpointRow): SerializedWebhookEndpoint {
  return {
    id: row.id,
    key_id: row.apiKeyId ?? "",
    url: row.url,
    events: row.events,
    description: row.description,
    disabled: Boolean(row.disabledAt),
    last_success_at: row.lastSuccessAt?.toISOString() ?? null,
    last_failure_at: row.lastFailureAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

/** An endpoint hears every event its key produces, across every domain that key reaches. */
function assertMayManageEndpoints(caller: WebhookCaller): void {
  if (caller.domainIds.length > 0) {
    throw new ApiError("key_not_scoped", "This key is limited to domains, so it can't manage webhook endpoints.");
  }
}

const KEY_SCOPED = isNotNull(webhookEndpoints.apiKeyId);

/** Endpoints on keys of the caller's own mode, when it has one. */
function sameMode(caller: WebhookCaller) {
  return caller.mode
    ? inArray(webhookEndpoints.apiKeyId, db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.mode, caller.mode)))
    : undefined;
}

async function assertKeyInOrganization(caller: WebhookCaller, keyId: string): Promise<void> {
  const [row] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.organizationId, caller.organizationId),
        eq(apiKeys.id, keyId),
        eq(apiKeys.scope, "organization"),
        isNull(apiKeys.revokedAt),
        caller.mode ? eq(apiKeys.mode, caller.mode) : undefined,
      ),
    )
    .limit(1);
  if (!row) throw new ApiError("not_found", `No key with id ${keyId}.`, { field: "key_id" });
}

/** Loads a key-scoped endpoint the caller may manage, or throws the error that says why not. */
export async function endpointRow(caller: WebhookCaller, id: string): Promise<WebhookEndpointRow> {
  assertMayManageEndpoints(caller);
  const [row] = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.organizationId, caller.organizationId), eq(webhookEndpoints.id, id), KEY_SCOPED, sameMode(caller)))
    .limit(1);
  if (!row) throw new ApiError("not_found", `No webhook endpoint with id ${id}.`);
  return row;
}

export interface CreatedWebhookEndpoint extends SerializedWebhookEndpoint {
  /** Shown once. Reveal it again on the key detail screen, or rotate for a new one. */
  secret: string;
}

export async function createWebhookEndpoint(
  caller: WebhookCaller,
  request: CreateWebhookEndpointRequest,
): Promise<CreatedWebhookEndpoint> {
  assertMayManageEndpoints(caller);
  await assertKeyInOrganization(caller, request.key_id);

  const { endpoint, secret } = await createEndpoint({
    organizationId: caller.organizationId,
    apiKeyId: request.key_id,
    url: request.url,
    events: request.events,
    description: request.description ?? null,
  });

  await recordActivity({
    organizationId: caller.organizationId,
    action: "webhook.endpoint.created",
    actor: caller.actor,
    appliesTo: endpoint.id,
    subjectLabel: endpoint.url,
    metadata: { apiKeyId: request.key_id, events: request.events },
  });

  return { ...serializeEndpoint(endpoint), secret };
}

export async function listWebhookEndpoints(
  caller: WebhookCaller,
  limit: number,
  cursor: string | undefined,
  filters: { key_id?: string },
): Promise<WebhookEndpointPage> {
  assertMayManageEndpoints(caller);

  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.organizationId, caller.organizationId),
        KEY_SCOPED,
        sameMode(caller),
        ...(filters.key_id ? [eq(webhookEndpoints.apiKeyId, filters.key_id)] : []),
        ...(cursor ? [keysetBefore({ table: webhookEndpoints, sort: webhookEndpoints.createdAt, id: webhookEndpoints.id }, cursor)] : []),
      ),
    )
    .orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return {
    data: page.map(serializeEndpoint),
    next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function readWebhookEndpoint(caller: WebhookCaller, id: string): Promise<SerializedWebhookEndpoint> {
  return serializeEndpoint(await endpointRow(caller, id));
}

export async function updateWebhookEndpoint(
  caller: WebhookCaller,
  id: string,
  request: UpdateWebhookEndpointRequest,
): Promise<SerializedWebhookEndpoint> {
  const existing = await endpointRow(caller, id);

  let row = existing;
  if (request.url !== undefined || request.events !== undefined || request.description !== undefined) {
    const updated = await updateEndpoint(caller.organizationId, id, {
      ...(request.url !== undefined ? { url: request.url } : {}),
      ...(request.events !== undefined ? { events: request.events } : {}),
      ...(request.description !== undefined ? { description: request.description } : {}),
    });
    if (!updated) throw new ApiError("not_found", `No webhook endpoint with id ${id}.`);
    row = updated;
  }

  if (request.disabled !== undefined && request.disabled !== Boolean(existing.disabledAt)) {
    const toggled = await setDisabled(caller.organizationId, id, request.disabled);
    if (!toggled) throw new ApiError("not_found", `No webhook endpoint with id ${id}.`);
    row = toggled;
    await recordActivity({
      organizationId: caller.organizationId,
      action: request.disabled ? "webhook.endpoint.disabled" : "webhook.endpoint.enabled",
      actor: caller.actor,
      appliesTo: id,
      subjectLabel: row.url,
      metadata: { apiKeyId: existing.apiKeyId },
    });
  }

  if (request.url !== undefined && request.url !== existing.url) {
    await recordActivity({
      organizationId: caller.organizationId,
      action: "webhook.endpoint.url.changed",
      actor: caller.actor,
      appliesTo: id,
      subjectLabel: row.url,
      metadata: { from: existing.url, to: row.url, apiKeyId: existing.apiKeyId },
    });
  }

  return serializeEndpoint(row);
}

export async function deleteWebhookEndpoint(caller: WebhookCaller, id: string): Promise<{ id: string; deleted: true }> {
  const existing = await endpointRow(caller, id);
  const deleted = await deleteEndpoint(caller.organizationId, id);
  if (!deleted) throw new ApiError("not_found", `No webhook endpoint with id ${id}.`);

  await recordActivity({
    organizationId: caller.organizationId,
    action: "webhook.endpoint.deleted",
    actor: caller.actor,
    appliesTo: id,
    subjectLabel: existing.url,
    metadata: { apiKeyId: existing.apiKeyId },
  });
  return { id, deleted: true };
}

/** Replaces the signing secret and returns the new one once. The old one stops verifying immediately. */
export async function rotateWebhookSecret(caller: WebhookCaller, id: string): Promise<CreatedWebhookEndpoint> {
  const existing = await endpointRow(caller, id);
  const secret = await rotateSecret(caller.organizationId, id);
  if (!secret) throw new ApiError("not_found", `No webhook endpoint with id ${id}.`);

  await recordActivity({
    organizationId: caller.organizationId,
    action: "webhook.secret.rotated",
    actor: caller.actor,
    appliesTo: id,
    subjectLabel: existing.url,
    metadata: { apiKeyId: existing.apiKeyId },
  });
  return { ...serializeEndpoint(existing), secret };
}
