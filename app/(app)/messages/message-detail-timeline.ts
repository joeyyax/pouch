import type { MessageTimelineEvent } from "@/lib/dashboard/views/messages";
import { clockTime } from "@/lib/format/time";

export interface TimelineEntry {
  marker: string;
  title: string;
  description?: string;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A stored ISO string back as a clock time, or null when the row didn't carry one. */
function clock(value: unknown, zone: string): string | null {
  const iso = str(value);
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : clockTime(date, zone);
}

/** The provider's words, quoted, as one sentence. */
function quoted(lead: string, reason: string | null): string | null {
  if (!reason) return null;
  return `${lead}: ${reason.replace(/\.$/, "")}.`;
}

/** The host of a webhook endpoint, which is the part that identifies it at a glance. */
function host(url: string | null): string {
  if (!url) return "your endpoint";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Who a provider event is about, so one delivery per recipient doesn't read as a repeat. */
function recipients(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const named = value.filter((one): one is string => typeof one === "string" && one.length > 0);
  return named.length > 0 ? `To ${named.join(", ")}.` : null;
}

const SUPPRESSION_SENTENCE: Record<string, (address: string) => string> = {
  hard_bounce: (address) => `Hard bounce on ${address}.`,
  complaint: (address) => `Complaint from ${address}.`,
};

function sentences(...parts: (string | null)[]): string | undefined {
  const said = parts.filter((part): part is string => Boolean(part));
  return said.length > 0 ? said.join(" ") : undefined;
}

/** One timeline row: what happened, in the voice the rest of the dashboard uses. Clock times are in `zone`. `from` names the sender on the send. */
export function timelineEntry(event: MessageTimelineEvent, zone: string, from?: string): TimelineEntry {
  const marker = clockTime(event.occurredAt, zone);
  const { detail } = event;

  if (event.kind === "retry") {
    const attempt = num(detail.attempt, 1);
    const next = clock(detail.nextAttemptAt, zone);
    return {
      marker,
      title: `attempt ${attempt} failed`,
      description: sentences(quoted("Provider rejected the message", event.reason), next && `Next attempt ${next}.`),
    };
  }

  if (event.kind === "backoff") {
    const until = clock(detail.until, zone);
    const count = num(detail.count, 1);
    return {
      marker,
      title: "backing off",
      description: sentences(
        quoted("The provider asked for a pause", event.reason),
        until && `Sending resumes ${until}.`,
        count > 1 ? `Held ${count} times.` : null,
      ),
    };
  }

  if (event.kind === "suppressed") {
    const address = str(detail.address) ?? "the address";
    const reason = str(detail.suppressionReason) ?? "hard_bounce";
    return {
      marker,
      title: "address suppressed",
      description: sentences(
        SUPPRESSION_SENTENCE[reason]?.(address) ?? `${address} suppressed.`,
        "Sends to it fail until you remove it.",
      ),
    };
  }

  if (event.kind === "body_shredded") {
    const days = num(detail.retentionDays, 0);
    return {
      marker,
      title: "body shredded",
      description: sentences(
        detail.retentionDays === null
          ? "It held a credential, so the key went once the message left the queue."
          : days > 0
            ? `Past the ${days}-day retention window.`
            : "Past the retention window.",
        "The delivery record stays.",
      ),
    };
  }

  if (event.kind === "abandoned") {
    return {
      marker,
      title: "no delivery confirmation",
      description: "The provider accepted it and never reported back. It says nothing about whether it landed.",
    };
  }

  if (event.kind === "webhook_delivered") {
    const eventType = str(detail.eventType) ?? "the event";
    const code = num(detail.statusCode, 200);
    return {
      marker,
      title: "webhook delivered",
      description: `${eventType} to ${host(str(detail.url))}, ${code}.`,
    };
  }

  return {
    marker,
    title: event.status ?? "event",
    description: sentences(event.status === "sent" && from ? `From ${from}.` : null, recipients(detail.recipients), event.reason),
  };
}
