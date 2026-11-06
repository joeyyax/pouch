/** The shapes the inbound screens render. Client-safe: nothing here reaches Postgres. */
import type { StatusDotTone } from "@/components/ui/status-dot";
import type { WebhookDeliveryStatus } from "@/lib/db/schema/webhooks";

export interface InboundDay {
  date: Date;
  received: number;
}

export interface InboundDelivery {
  status: WebhookDeliveryStatus;
  lastStatusCode: number | null;
  lastError: string | null;
  attempts: number;
}

export const DELIVERY_TONE: Record<WebhookDeliveryStatus, StatusDotTone> = {
  pending: "neutral",
  succeeded: "good",
  failed: "warn",
  exhausted: "issue",
};

/** Failed is still retrying; exhausted has given up. */
export const DELIVERY_LABEL: Record<WebhookDeliveryStatus, string> = {
  pending: "pending",
  succeeded: "delivered",
  failed: "retrying",
  exhausted: "failed",
};

/** The endpoint's last answer, for a chip's hover. */
export function deliveryDetail(delivery: InboundDelivery): string {
  const answer = delivery.lastStatusCode ? `HTTP ${delivery.lastStatusCode}` : delivery.lastError;
  const tries = `${delivery.attempts} ${delivery.attempts === 1 ? "attempt" : "attempts"}`;
  const label = DELIVERY_LABEL[delivery.status];
  return answer ? `Webhook ${label}: ${answer}, ${tries}` : `Webhook ${label}, ${tries}`;
}
