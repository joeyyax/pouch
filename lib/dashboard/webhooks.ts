/** The key detail screen's webhook loaders. Deliveries read through the API's `lib/webhooks/deliveries`. */
import { ApiError } from "@/lib/api/errors";
import { listWebhookDeliveries, readWebhookDelivery, type SerializedWebhookDelivery } from "@/lib/webhooks/deliveries";
import { listWebhookEndpoints, type SerializedWebhookEndpoint, type WebhookCaller } from "@/lib/webhooks/manage";
import type {
  WebhookDeliveryDetailView,
  WebhookDeliveryView,
  WebhookEndpointView,
} from "@/lib/dashboard/views/webhooks";

function endpointView(endpoint: SerializedWebhookEndpoint): WebhookEndpointView {
  return {
    id: endpoint.id,
    url: endpoint.url,
    events: endpoint.events,
    description: endpoint.description,
    disabled: endpoint.disabled,
    lastSuccessAt: endpoint.last_success_at ? new Date(endpoint.last_success_at) : null,
    lastFailureAt: endpoint.last_failure_at ? new Date(endpoint.last_failure_at) : null,
    createdAt: new Date(endpoint.created_at),
  };
}

/** Every endpoint on a key, newest first, read the way `GET /v1/webhook_endpoints?key_id=` reads them. */
export async function listEndpointViews(caller: WebhookCaller, apiKeyId: string): Promise<WebhookEndpointView[]> {
  const endpoints: SerializedWebhookEndpoint[] = [];
  let cursor: string | undefined;
  do {
    const page = await listWebhookEndpoints(caller, 200, cursor, { key_id: apiKeyId });
    endpoints.push(...page.data);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return endpoints.map(endpointView);
}

function deliveryView(delivery: SerializedWebhookDelivery): WebhookDeliveryView {
  return {
    id: delivery.id,
    eventType: delivery.event_type,
    status: delivery.status,
    attempts: delivery.attempt_count,
    nextAttemptAt: delivery.next_attempt_at ? new Date(delivery.next_attempt_at) : null,
    lastStatusCode: delivery.last_status_code,
    lastError: delivery.last_error,
    createdAt: new Date(delivery.created_at),
  };
}

/** The newest deliveries to an endpoint. The payload loads with the dialog, not the list. */
export async function listDeliveries(caller: WebhookCaller, endpointId: string, limit = 20): Promise<WebhookDeliveryView[]> {
  const page = await listWebhookDeliveries(caller, endpointId, limit, undefined);
  return page.data.map(deliveryView);
}

/** One delivery's payload and attempts. Null when it isn't the endpoint's, in the caller's organization. */
export async function readDeliveryDetail(
  caller: WebhookCaller,
  endpointId: string,
  deliveryId: string,
): Promise<WebhookDeliveryDetailView | null> {
  try {
    const delivery = await readWebhookDelivery(caller, endpointId, deliveryId, { payload: true, attempts: true });
    return {
      payload: delivery.payload ?? {},
      attempts: (delivery.attempts ?? []).map((attempt) => ({
        attempt: attempt.attempt,
        statusCode: attempt.status_code,
        error: attempt.error,
        durationMs: attempt.duration_ms,
        createdAt: new Date(attempt.created_at),
      })),
    };
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return null;
    throw error;
  }
}
