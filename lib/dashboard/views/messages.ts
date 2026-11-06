/**
 * The shapes the messages screen renders, and the pure helpers it calls.
 *
 * lib/dashboard/views is the client boundary: every value a screen needs at runtime lives here,
 * and nothing under it imports a module that reaches Postgres, object storage or Redis. A value
 * imported from one of those into a "use client" file drags the Postgres driver into the browser
 * bundle — which typecheck and lint both allow, and only the browser catches. Types are erased,
 * so a client component may still import one from a loader.
 */
import type {
  MessageEnvelope,
  MessageEventKind,
  MessageStatus,
  MessageWarning,
} from "@/lib/db/schema";
import type { SnippetLanguage } from "@/lib/dashboard/curl";
import type { MessageBody } from "@/lib/messages/body-state";
import type { SerializedMessageStall } from "@/lib/messages/serialize";

/** The window the list covers, and what the header says it covers. */
export const LIST_WINDOW_DAYS = 7;

/** Rows one page of the list holds. The dashboard is one operator, not a report tool. */
export const LIST_LIMIT = 100;

/** A message queued longer than this is the service's problem, not the provider's. */
export const QUEUE_WINDOW_MINUTES = 5;

export function isStuckInQueue(status: MessageStatus, createdAt: Date, now = new Date()): boolean {
  return status === "queued" && now.getTime() - createdAt.getTime() > QUEUE_WINDOW_MINUTES * 60_000;
}

export interface MessageListItem {
  id: string;
  status: MessageStatus;
  subject: string;
  /** The first recipient. `recipientCount` says how many more there are. */
  to: string;
  /** Every recipient across to, cc and bcc. A send takes a list; the row can't pretend it didn't. */
  recipientCount: number;
  domainName: string;
  /** Null when no key sent it: the dashboard, system mail, list confirmations. */
  keyId: string | null;
  keyName: string | null;
  createdAt: Date;
  testMode: boolean;
  /** The body is withheld from every read. */
  sensitive: boolean;
  /** True when any recipient is suppressed, not only the first. */
  suppressed: boolean;
  stuck: boolean;
}

export type { BodyAttachment, MessageBody } from "@/lib/messages/body-state";

export interface MessageRecipient {
  address: string;
  field: "to" | "cc" | "bcc";
  suppressed: boolean;
  suppressedAt: Date | null;
}

export interface MessageTimelineEvent {
  id: string;
  kind: MessageEventKind;
  /** The lifecycle status, on a transition. Null on every other kind. */
  status: MessageStatus | null;
  reason: string | null;
  /** The occurrence's structured facts. The timeline words them. */
  detail: Record<string, unknown>;
  occurredAt: Date;
}

export type MessageFactTone = "good" | "neutral" | "warn";

/** One sentence about the message worth a second look. See lib/dashboard/message-facts.ts. */
export interface MessageFact {
  text: string;
  tone: MessageFactTone;
  score: number;
}

/** A reply received to a sent message — the inbound side of the conversation. */
export interface MessageReplyItem {
  id: string;
  from: string;
  subject: string;
  receivedAt: Date;
}

/** A request and the exact response the API returns for it. */
export interface ApiExchange {
  request: string;
  response: string;
}

/** The body tabs, loaded when one opens. */
export interface MessageBodyView {
  /** As stored, except `html` is what the recipient got: framed when the send asked for the layout. */
  body: MessageBody;
  /** The html is wrapped in the domain's layout. */
  framed: boolean;
  /** The layout changed after the send, so the frame shown isn't the one sent. Null when that can't be told. */
  frameChanged: boolean | null;
}

export interface MessageDetailData {
  id: string;
  status: MessageStatus;
  subject: string;
  fromAddress: string;
  fromName: string | null;
  envelope: MessageEnvelope;
  tags: string[];
  testMode: boolean;
  /** Recipient-history hints from send time. See lib/messages/history.ts. */
  warnings: MessageWarning[];
  /** The send asked to be wrapped in the domain's frame. */
  layout: boolean;
  providerMessageId: string | null;
  failureReason: string | null;
  attempts: number;
  createdAt: Date;
  sentAt: Date | null;
  nextAttemptAt: Date | null;
  stuck: boolean;
  /** What holds this queued message, in the API's shape. Null when nothing does. */
  stall: SerializedMessageStall | null;
  /** Set by the abandon sweep. `status` stays `sent` — this is the marker, not a new state. */
  abandonedAt: Date | null;
  /** Bytes as accepted, in the API's shape. Null parts predate sizes. */
  size: { body_bytes: number | null; attachment_bytes: number | null };
  domainId: string;
  domainName: string;
  /** Null when no key sent it. */
  keyId: string | null;
  keyName: string | null;
  keyRevoked: boolean;
  /** Newest first — the answer is the top of the timeline. */
  events: MessageTimelineEvent[];
  /** Every recipient the send named, in the field it came from. */
  recipients: MessageRecipient[];
  /**
   * How many messages this organization has sent to the only recipient. Null when the message
   * had more than one, because one number can't stand for several addresses.
   */
  messageCount: number | null;
  /** The header block as a mail client would show it, from what the service actually holds. */
  headers: string;
  /** `GET /v1/emails/:id` as the API answers it, in curl and the SDK. The `include=body` response loads when its tab opens. */
  api: { plain: { requests: SnippetLanguage[]; response: string }; withBodyRequests: SnippetLanguage[] };
  /** Inbound replies matched to this send — newest first. Empty for most messages. */
  replies: MessageReplyItem[];
  /** Highest score first. Empty when nothing about the message stands out. */
  facts: MessageFact[];
  /** The message this one was resent from. Null for an original send. */
  resentFrom: string | null;
  /** Copies resent from this message, oldest first. */
  resends: { id: string; status: MessageStatus; createdAt: Date }[];
  /** Why Resend is off, or null when it's on. */
  resendBlocked: string | null;
}
