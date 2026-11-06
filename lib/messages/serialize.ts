import type { MessageEventKind, MessageEventRow, MessageRow, MessageWarning } from "@/lib/db/schema";
import { isTransition } from "@/lib/db/schema";
import { messageUrl } from "@/lib/api/urls";
import { describeStall, type StallReason } from "@/lib/domains/guard";
import type { DomainStallState } from "@/lib/domains/stall";
import type { LayoutOverrides } from "@/lib/domains/layout";

/** `provider_paused` is an organization hold only: the provider paused the organization's sending. */
export type MessageHoldReason = StallReason | "provider_paused";

/** A suspension holding this message's organization, read via `suspensionOf`. */
export interface OrganizationStallState {
  stalledAt: Date;
  reason: MessageHoldReason;
  message: string;
}

/** `layout` as the send asked for it: false, true, or the fields it overrode. */
export type SerializedLayout = boolean | LayoutOverrides;

export interface SerializedMessage {
  id: string;
  url: string;
  status: MessageRow["status"];
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[];
  subject: string;
  tags: string[];
  /** Custom headers as accepted. */
  headers: Record<string, string>;
  layout: SerializedLayout;
  /** The key that sent it. Null when no key did: the dashboard, system mail, list confirmations. */
  key_id: string | null;
  /** The batch it was sent in. Null for a single send. */
  batch_id: string | null;
  test_mode: boolean;
  /** The body is withheld from every read: the sender marked it, or it carried a credential. */
  sensitive: boolean;
  warnings: MessageWarning[];
  provider_message_id: string | null;
  reason: string | null;
  attempts: number;
  /** When the worker next tries to send it. Null unless queued. */
  next_attempt_at: string | null;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  /** When the provider took it and never reported back. Status stays sent. */
  abandoned_at: string | null;
  /** Bytes as accepted. Each is null for a message accepted before sizes were recorded. */
  size: { body_bytes: number | null; attachment_bytes: number | null };
  /** The message this one was resent from. Null for an original send. */
  resent_from: string | null;
  events?: SerializedEvent[];
  occurrences?: SerializedOccurrence[];
  stall?: SerializedMessageStall | null;
}

export interface SerializedEvent {
  id: string;
  status: MessageRow["status"];
  reason: string | null;
  occurred_at: string;
}

export type OccurrenceKind = Exclude<MessageEventKind, "transition">;

export interface OccurrenceDetails {
  retry: { attempt: number | null; next_attempt_at: string | null };
  backoff: { until: string | null; count: number };
  suppressed: { address: string | null; suppression_reason: string | null };
  body_shredded: { retention_days: number | null };
  webhook_delivered: { event_type: string | null; host: string | null; status_code: number | null };
  abandoned: Record<string, never>;
}

/** Something that happened to a message without changing its status. */
export type SerializedOccurrence = {
  [K in OccurrenceKind]: { id: string; kind: K; reason: string | null; occurred_at: string; detail: OccurrenceDetails[K] };
}[OccurrenceKind];

export interface SerializedMessageStall {
  /** Which level is held: the message's own domain, or its organization under a suspension that holds the queue. */
  kind: "domain" | "organization";
  reason: MessageHoldReason;
  message: string;
  stalled_at: string;
}

type BaseKey = Exclude<keyof SerializedMessage, "events" | "occurrences" | "stall">;
type Column = keyof MessageRow;

interface BaseReader<K extends BaseKey> {
  columns: readonly Column[];
  read: (message: MessageRow) => SerializedMessage[K];
}

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** Every key of a message's base shape, in response order: the columns it reads and how. */
const BASE: { [K in BaseKey]: BaseReader<K> } = {
  id: { columns: ["id"], read: (m) => m.id },
  url: { columns: ["id"], read: (m) => messageUrl(m.id) },
  status: { columns: ["status"], read: (m) => m.status },
  from: { columns: ["envelope"], read: (m) => (m.envelope.fromName ? `${m.envelope.fromName} <${m.envelope.from}>` : m.envelope.from) },
  to: { columns: ["envelope"], read: (m) => m.envelope.to },
  cc: { columns: ["envelope"], read: (m) => m.envelope.cc },
  bcc: { columns: ["envelope"], read: (m) => m.envelope.bcc },
  reply_to: { columns: ["envelope"], read: (m) => m.envelope.replyTo },
  subject: { columns: ["subject"], read: (m) => m.subject },
  tags: { columns: ["tags"], read: (m) => m.tags },
  headers: { columns: ["envelope"], read: (m) => m.envelope.headers },
  layout: { columns: ["layout", "layoutOverrides"], read: (m) => (m.layout ? (m.layoutOverrides ?? true) : false) },
  key_id: { columns: ["apiKeyId"], read: (m) => m.apiKeyId },
  batch_id: { columns: ["batchId"], read: (m) => m.batchId },
  test_mode: { columns: ["testMode"], read: (m) => m.testMode },
  sensitive: { columns: ["bodyWithheld"], read: (m) => typeof m.bodyWithheld === "string" },
  warnings: { columns: ["warnings"], read: (m) => m.warnings },
  provider_message_id: { columns: ["providerMessageId"], read: (m) => m.providerMessageId },
  reason: { columns: ["failureReason"], read: (m) => m.failureReason },
  attempts: { columns: ["attempts"], read: (m) => m.attempts },
  // Only the worker schedules, and only a queued message.
  next_attempt_at: { columns: ["status", "nextAttemptAt"], read: (m) => (m.status === "queued" ? iso(m.nextAttemptAt) : null) },
  created_at: { columns: ["createdAt"], read: (m) => m.createdAt.toISOString() },
  sent_at: { columns: ["sentAt"], read: (m) => iso(m.sentAt) },
  delivered_at: { columns: ["deliveredAt"], read: (m) => iso(m.deliveredAt) },
  abandoned_at: { columns: ["abandonedAt"], read: (m) => iso(m.abandonedAt) },
  size: { columns: ["bodyBytes", "attachmentBytes"], read: (m) => ({ body_bytes: m.bodyBytes, attachment_bytes: m.attachmentBytes }) },
  resent_from: { columns: ["resentFrom"], read: (m) => m.resentFrom ?? null },
};

export const MESSAGE_BASE_KEYS = Object.keys(BASE) as BaseKey[];

/** The row columns these response keys read. Keys outside the base shape read none here. */
export function baseColumns(keys: Iterable<string>): Set<Column> {
  const columns = new Set<Column>();
  for (const key of keys) for (const column of BASE[key as BaseKey]?.columns ?? []) columns.add(column);
  return columns;
}

function serializeBase(message: MessageRow, keys?: ReadonlySet<string>): SerializedMessage {
  const base: Record<string, unknown> = {};
  for (const key of MESSAGE_BASE_KEYS) if (!keys || keys.has(key)) base[key] = BASE[key].read(message);
  return base as unknown as SerializedMessage;
}

const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown) => (typeof value === "number" ? value : null);

function host(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** The stored detail in the API's words. The endpoint's host only: its path and query can carry a secret. */
function occurrenceDetail(event: MessageEventRow): OccurrenceDetails[OccurrenceKind] {
  const detail = event.detail;
  switch (event.kind as OccurrenceKind) {
    case "retry":
      return { attempt: num(detail.attempt), next_attempt_at: str(detail.nextAttemptAt) };
    case "backoff":
      return { until: str(detail.until), count: num(detail.count) ?? 1 };
    case "suppressed":
      return { address: str(detail.address), suppression_reason: str(detail.suppressionReason) };
    case "body_shredded":
      return { retention_days: num(detail.retentionDays) };
    case "webhook_delivered":
      return { event_type: str(detail.eventType), host: host(str(detail.url)), status_code: num(detail.statusCode) };
    default:
      return {};
  }
}

export function serializeOccurrence(event: MessageEventRow): SerializedOccurrence {
  return {
    id: event.id,
    kind: event.kind,
    reason: event.reason,
    occurred_at: event.occurredAt.toISOString(),
    detail: occurrenceDetail(event),
  } as SerializedOccurrence;
}

export interface SerializeOptions {
  /** Every event row, oldest first. Transitions become `events`. */
  events?: MessageEventRow[] | undefined;
  /** Adds `occurrences` from the same rows. */
  occurrences?: boolean | undefined;
  /** The message's domain, when it's queued and the domain is stalled. `undefined` omits `stall` entirely. */
  domainStall?: DomainStallState | null | undefined;
  /** The message's organization, when it's queued under a holding suspension and its domain isn't itself stalled. */
  organizationStall?: OrganizationStallState | null | undefined;
  /** Base keys to build. Every one when unset; a row read for fewer columns needs this. */
  keys?: ReadonlySet<string> | undefined;
}

export function serializeMessage(message: MessageRow, options: SerializeOptions = {}): SerializedMessage {
  const { events, domainStall, organizationStall } = options;
  return {
    ...serializeBase(message, options.keys),
    ...(events
      ? {
          events: events.filter(isTransition).map((event) => ({
            id: event.id,
            status: event.status,
            reason: event.reason,
            occurred_at: event.occurredAt.toISOString(),
          })),
        }
      : {}),
    ...(events && options.occurrences ? { occurrences: events.filter((event) => !isTransition(event)).map(serializeOccurrence) } : {}),
    // Undefined omits the key entirely; null means queued but not held. Lets a caller polling a
    // stuck message tell "queued, waiting on capacity" from "queued, the domain is held".
    ...(domainStall !== undefined
      ? {
          stall: domainStall
            ? {
                kind: "domain" as const,
                reason: domainStall.reason,
                message: domainStall.detail ? describeStall(domainStall.reason, domainStall.detail) : "This domain is paused.",
                stalled_at: domainStall.stalledAt.toISOString(),
              }
            : organizationStall
              ? {
                  kind: "organization" as const,
                  reason: organizationStall.reason,
                  message: organizationStall.message,
                  stalled_at: organizationStall.stalledAt.toISOString(),
                }
              : null,
        }
      : {}),
  };
}
