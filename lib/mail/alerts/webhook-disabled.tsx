import type { WebhookEndpointRow } from "@/lib/db/schema";
import { sendSystemAlert } from "@/lib/mail/system";
import { SystemMail, type SystemMailBody } from "@/lib/mail/template";
import { organizationName } from "./names";

/**
 * One state change, one alert: the idempotency key is the endpoint and the moment it was
 * disabled, so a worker that reprocesses the same exhausted delivery — or restarts mid-run —
 * replays the same message instead of sending a second one.
 */
function idempotencyKey(endpoint: WebhookEndpointRow): string {
  const disabledAt = endpoint.disabledAt?.toISOString() ?? "unknown";
  return `webhook-endpoint-disabled:${endpoint.id}:${disabledAt}`;
}

/** The alert's body; the footer is added per recipient. */
export function webhookDisabledMail(endpoint: WebhookEndpointRow, consecutiveFailures: number, organization: string): Omit<SystemMailBody, "reason"> {
  return {
    heading: "A webhook endpoint turned itself off",
    paragraphs: [
      `${consecutiveFailures} deliveries in a row to ${endpoint.url} ran out of retries, so the endpoint is disabled.`,
      "Fix the receiver, then turn the endpoint back on from the dashboard.",
    ],
    facts: [
      ["Endpoint", endpoint.url],
      ["Organization", organization],
    ],
  };
}

export function WebhookDisabledEmail({ endpoint, consecutiveFailures, organization, reason }: { endpoint: WebhookEndpointRow; consecutiveFailures: number; organization: string; reason: string }) {
  return <SystemMail {...webhookDisabledMail(endpoint, consecutiveFailures, organization)} reason={reason} />;
}

/** Sends the alert for one endpoint that just disabled itself. `endpoint` must already carry `disabledAt`. */
export async function sendWebhookDisabledAlert(endpoint: WebhookEndpointRow, consecutiveFailures: number): Promise<void> {
  const organization = await organizationName(endpoint.organizationId);
  await sendSystemAlert({
    subject: `Webhook endpoint disabled: ${endpoint.url}`,
    email: (reason) => <WebhookDisabledEmail endpoint={endpoint} consecutiveFailures={consecutiveFailures} organization={organization} reason={reason} />,
    idempotencyKey: idempotencyKey(endpoint),
  });
}
