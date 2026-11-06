import type { MessageRow } from "@/lib/db/schema";
import { readBody, type StoredBody } from "@/lib/storage/bodies";
import { logger } from "@/lib/logger";
import { bodyKeptUntil } from "./retention";
import { messageDownloadUrl, MESSAGE_DOWNLOAD_URL_TTL_SECONDS } from "./downloads";
import { withheldBodyMessage, type BodyGone, type MessageBody } from "./body-state";
import { base64Bytes } from "./size";
import { safeErrorMessage } from "@/lib/errors/scrub";

export type { BodyAttachment, BodyGone, MessageBody } from "./body-state";
export { withheldBodyMessage, withheldSentence } from "./body-state";

const log = logger.child("messages:body");

/**
 * Reads the body from object storage. A body that's been purged or has aged out says so;
 * storage being down says that instead, because the two aren't the same answer.
 *
 * `retentionDays` is the organization's setting, so a row can be expired on the org's clock
 * even when the bucket's lifecycle rule is set further out.
 */
export async function loadBody(message: MessageRow, retentionDays: number, now = new Date()): Promise<MessageBody> {
  const stored = await loadStoredBody(message, retentionDays, now);
  if (stored.state !== "available") return stored;
  const { body } = stored;
  return {
    state: "available",
    html: body.html,
    text: body.text,
    attachments: body.attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      bytes: base64Bytes(attachment.content),
    })),
  };
}

/** Why the row alone says the body can't be read, or null when storage has to be asked. */
export function bodyGoneFromRow(
  message: Pick<MessageRow, "bodyWithheld" | "bodyPurgedAt" | "bodyKey" | "createdAt">,
  retentionDays: number,
  now = new Date(),
): BodyGone | null {
  if (typeof message.bodyWithheld === "string") return { state: "withheld", reason: message.bodyWithheld };
  if (message.bodyPurgedAt) return { state: "purged", purgedAt: message.bodyPurgedAt };
  // A null key with no stamp predates encryption. The body can't be read either way,
  // but there's no purge date to claim, so don't invent one.
  if (!message.bodyKey) return { state: "purged", purgedAt: null };
  const keptUntil = bodyKeptUntil(message.createdAt, retentionDays);
  if (keptUntil <= now) return { state: "expired", keptUntil };
  return null;
}

/** The stored body with attachment content, or why it can't be read. */
export async function loadStoredBody(
  message: MessageRow,
  retentionDays: number,
  now = new Date(),
): Promise<{ state: "available"; body: StoredBody } | BodyGone> {
  const gone = bodyGoneFromRow(message, retentionDays, now);
  if (gone) return gone;
  if (!message.bodyKey || !message.storageKey) return { state: "unavailable" };

  try {
    return { state: "available", body: await readBody(Buffer.from(message.bodyKey, "base64"), message.storageKey) };
  } catch (err) {
    log.warn(`reading the body for ${message.id} failed: ${safeErrorMessage(err)}`);
    return { state: "unavailable" };
  }
}

export interface SerializedBodyAttachment {
  filename: string;
  content_type: string;
  size: number;
  /** A link that expires, minted on read. */
  download_url: string;
}

export interface SerializedBody {
  /** As accepted, before the domain's layout wraps it. */
  html: string | null;
  text: string | null;
  attachments: SerializedBodyAttachment[];
}

export interface SerializedBodyUnavailable {
  reason: "withheld" | "shredded" | "expired" | "unavailable";
  message: string;
  /** When the body stopped being readable. Null when storage didn't answer or the row predates encryption. */
  ended_at: string | null;
}

/** Why the body can't be read, or null when it can. */
export function bodyUnavailable(body: MessageBody): SerializedBodyUnavailable | null {
  if (body.state === "available") return null;
  if (body.state === "withheld") {
    return { reason: "withheld", message: withheldBodyMessage(body.reason), ended_at: null };
  }
  if (body.state === "purged") {
    return body.purgedAt
      ? { reason: "shredded", message: "The body was shredded past the retention window. Events are kept.", ended_at: body.purgedAt.toISOString() }
      : { reason: "shredded", message: "This message predates body encryption, so its body can't be read. Events are kept.", ended_at: null };
  }
  if (body.state === "expired") {
    return { reason: "expired", message: "The body is past the retention window. Events are kept.", ended_at: body.keptUntil.toISOString() };
  }
  return { reason: "unavailable", message: "Storage didn't answer. The body may still be there; read the message again.", ended_at: null };
}

/** `body` and `body_unavailable`: exactly one of them is null. */
export function serializeBody(
  messageId: string,
  body: MessageBody,
  now = new Date(),
): { body: SerializedBody | null; body_unavailable: SerializedBodyUnavailable | null } {
  if (body.state !== "available") return { body: null, body_unavailable: bodyUnavailable(body) };
  return {
    body: {
      html: body.html,
      text: body.text,
      attachments: body.attachments.map((attachment, index) => ({
        filename: attachment.filename,
        content_type: attachment.contentType,
        size: attachment.bytes,
        download_url: messageDownloadUrl(messageId, index, MESSAGE_DOWNLOAD_URL_TTL_SECONDS, now),
      })),
    },
    body_unavailable: null,
  };
}
