import type { MessageStatus } from "@/lib/db/schema";
import type { Receipt } from "@/lib/providers/adapters/types";

/** Attempts a message gets before a transient failure becomes a permanent one. */
export const MAX_ATTEMPTS = 5;

const BASE_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

/** How long a message may sit queued before it fails, however the provider is behaving. */
export const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000;

export type DeliveryAction =
  | { kind: "sent"; status: Extract<MessageStatus, "sent">; providerMessageId: string }
  | { kind: "retry"; retryInMs: number; reason: string }
  | { kind: "failed"; status: Extract<MessageStatus, "failed">; reason: string }
  | { kind: "backoff"; backoffMs: number; reason: string; accountWide: boolean };

/** Exponential backoff with full jitter, capped at 30 minutes. */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(BASE_BACKOFF_MS + random() * Math.max(0, ceiling - BASE_BACKOFF_MS));
}

/**
 * Turns a receipt into the worker's next move.
 * `backoff` pauses the provider and leaves the message queued without spending an attempt.
 */
export function decideDelivery(
  receipt: Receipt,
  attempts: number,
  random: () => number = Math.random,
  queuedForMs = 0,
): DeliveryAction {
  if (receipt.successful) {
    return { kind: "sent", status: "sent", providerMessageId: receipt.providerMessageId };
  }

  const reason = receipt.errors.join("; ") || "Provider rejected the message.";

  // A provider that never stops throttling would otherwise hold its messages forever.
  if (queuedForMs >= MAX_QUEUE_AGE_MS) {
    return { kind: "failed", status: "failed", reason };
  }

  if (receipt.failure === "backoff") {
    return { kind: "backoff", backoffMs: (receipt.retryAfterSeconds ?? 60) * 1000, reason, accountWide: receipt.accountWide ?? false };
  }
  if (receipt.failure === "transient" && attempts < MAX_ATTEMPTS) {
    return { kind: "retry", retryInMs: retryDelayMs(attempts, random), reason };
  }
  return { kind: "failed", status: "failed", reason };
}

/** Formats a provider rejection for the message row and the dashboard. */
export function failureMessage(reason: string): string {
  return `Provider rejected the message: ${reason}.`;
}
