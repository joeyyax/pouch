import { project, type Selection } from "@/lib/api/shape";
import { inboundMessageUrl } from "@/lib/api/urls";
import type { InboundMessageRow } from "@/lib/db/schema";
import type { InboundVerdicts } from "@/lib/providers/adapters/types";
import { readInboundBody, type InboundBody } from "./attachments";
import { INBOUND_DOWNLOAD_URL_TTL_SECONDS } from "./constants";
import { inboundDownloadUrl } from "./downloads";
import type { SerializedWebhookDelivery } from "@/lib/webhooks/deliveries";

export interface SerializedInboundAttachment {
  filename: string;
  content_type: string;
  size: number;
  /** True when the message failed a virus scan and the content wasn't kept. */
  quarantined: boolean;
  /** A link that expires, minted on read. Null in a webhook payload and when quarantined. */
  download_url: string | null;
}

export interface SerializedInboundMessage {
  id: string;
  url: string;
  domain_id: string;
  from: string;
  to: string[];
  subject: string;
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
  message_id: string | null;
  in_reply_to: string | null;
  outbound_message_id: string | null;
  attachments: SerializedInboundAttachment[];
  /** The message as received, as a link that expires. Null in a webhook payload, or when the provider didn't hand it over. */
  raw_download_url: string | null;
  /** The provider's scan results, lowercased. Null when it doesn't scan. */
  verdicts: InboundVerdicts | null;
  /** Addresses this message was delivered to. */
  address_ids: string[];
  /** Shared by every message in the same conversation, prefixed thr_. */
  thread_id: string;
  received_at: string;
  expires_at: string;
}

/** Download links for a message's stored objects. */
export interface InboundLinks {
  attachments: (string | null)[];
  raw: string | null;
}

/** Mints fresh links for every object the row points at. */
export function inboundLinks(message: InboundMessageRow): InboundLinks {
  const ttl = INBOUND_DOWNLOAD_URL_TTL_SECONDS;
  return {
    attachments: message.attachments.map((attachment, index) => (attachment.storageKey ? inboundDownloadUrl(message.id, index, ttl) : null)),
    raw: message.rawStorageKey ? inboundDownloadUrl(message.id, "raw", ttl) : null,
  };
}

/** The API shape. Without `links`, as a webhook carries it: no download links. */
export function serializeInboundMessage(message: InboundMessageRow, body: InboundBody, links?: InboundLinks): SerializedInboundMessage {
  return {
    id: message.id,
    url: inboundMessageUrl(message.id),
    domain_id: message.domainId,
    from: message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress,
    to: message.to,
    subject: message.subject,
    text: body.text,
    html: body.html,
    headers: message.headers,
    message_id: message.messageId,
    in_reply_to: message.inReplyTo,
    outbound_message_id: message.outboundMessageId,
    attachments: message.attachments.map((attachment, index) => ({
      filename: attachment.filename,
      content_type: attachment.contentType,
      size: attachment.size,
      quarantined: attachment.storageKey === null,
      download_url: links?.attachments[index] ?? null,
    })),
    raw_download_url: links?.raw ?? null,
    verdicts: message.verdicts,
    address_ids: message.addressIds,
    thread_id: message.threadId,
    received_at: message.receivedAt.toISOString(),
    expires_at: message.expiresAt.toISOString(),
  };
}

/** The API shape with its body read from storage and fresh download links. */
export async function serializeInboundWithLinks(message: InboundMessageRow): Promise<SerializedInboundMessage> {
  return serializeInboundMessage(message, await readInboundBody(message), inboundLinks(message));
}

export type InboundResponse = Partial<SerializedInboundMessage & { delivery: SerializedWebhookDelivery | null }>;

/** One message as the API returns it under `selection`. Storage is read only when the body is selected. */
export async function inboundResponse(
  message: InboundMessageRow,
  selection: Selection,
  delivery?: SerializedWebhookDelivery | null,
): Promise<InboundResponse> {
  const body = selection.expands("body") ? await readInboundBody(message) : { text: null, html: null };
  const serialized = serializeInboundMessage(message, body, inboundLinks(message));
  return project(delivery === undefined ? serialized : { ...serialized, delivery }, selection);
}
