/**
 * Operator alerts about the service's own health, never email — the thing that would send the
 * email is what's down (docs/engineering.md). Posts to an ntfy topic: ntfy.sh by default, or a
 * self-hosted server via NTFY_URL. Unset NTFY_URL/NTFY_TOPIC means push isn't configured, and a
 * send is skipped with a warning rather than thrown, so a missing alert never blocks the work
 * that triggered it — the caller still wraps this in .catch() for the same reason.
 */
import { logger } from "@/lib/logger";
import { fetchWithTimeout } from "@/lib/fetch-timeout";

const log = logger.child("notifications:push");

const DEFAULT_NTFY_URL = "https://ntfy.sh";

// Shorter than the provider timeouts: a push is a notification about work, never the work. It is
// also reached from inside the stall guard's tick, where a hang would stop all stall checking.
const PUSH_TIMEOUT_MS = 10_000;

export interface PushAlertInput {
  title: string;
  /** Present tense, names the thing and the number. No exclamation marks. */
  message: string;
  tags?: string[];
  /** ntfy priority, 1 (min) to 5 (max). Defaults to 3 (default). */
  priority?: 1 | 2 | 3 | 4 | 5;
  /** Where tapping the notification lands. The detail view for what the message names. */
  click?: string;
}

export function pushConfigured(): boolean {
  return Boolean(process.env.NTFY_TOPIC);
}

/** Publishes one push notification. Throws on a non-2xx response; callers decide whether that's fatal. */
export async function sendPushAlert(input: PushAlertInput): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    log.warn(`push alert skipped, NTFY_TOPIC not set: ${input.title}`);
    return;
  }
  const url = process.env.NTFY_URL || DEFAULT_NTFY_URL;

  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = process.env.NTFY_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  const { response, text } = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        topic,
        title: input.title,
        message: input.message,
        tags: input.tags,
        priority: input.priority,
        click: input.click,
      }),
    },
    PUSH_TIMEOUT_MS,
    "ntfy",
  );

  if (!response.ok) {
    throw new Error(`ntfy responded ${response.status}: ${text}`);
  }
}
