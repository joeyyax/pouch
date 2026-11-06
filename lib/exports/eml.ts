/**
 * One message rebuilt as an RFC 5322 .eml — the format every mail client already opens.
 * Built from the stored envelope and body, not captured at send time, so it's a faithful
 * reconstruction rather than the exact bytes a provider transmitted.
 *
 * Reuses lib/providers/adapters/mime.ts's buildMime, the same MIME builder a provider adapter sends —
 * one MIME implementation, not a second one that can drift from what actually went out.
 *
 * Deliberately doesn't reuse lib/messages/body.ts's loadBody: that function trims
 * attachments down to a byte count for the dashboard's detail screen, which is right for a
 * screen and wrong for an export that has to reproduce the attachment itself. This mirrors
 * its purged/expired/unavailable states (bodyKeptUntil comes from there directly, so the two
 * never disagree about when a body ages out) but reads the full body from storage.
 */
import type { MessageRow } from "@/lib/db/schema";
import { bodyKeptUntil } from "@/lib/messages/retention";
import { withheldBodyMessage } from "@/lib/messages/body-state";
import { buildMime } from "@/lib/providers/adapters/mime";
import type { OutboundMessage } from "@/lib/providers/adapters/types";
import { readBody } from "@/lib/storage/bodies";
import { logger } from "@/lib/logger";
import { brand } from "@/lib/brand";
import { WIRE_HEADERS } from "@/lib/wire";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("exports:eml");

export type ExportBodyStatus = "available" | "withheld" | "shredded" | "expired" | "unavailable";

export interface ExportBody {
  status: ExportBodyStatus;
  /** One sentence, voice-guide style, explaining the status. Always set — never a blank field. */
  reason: string;
  html: string | null;
  text: string | null;
  attachments: { filename: string; content: string; contentType: string }[];
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Reads a message's body for export, with the same three failure states loadBody reports
 * (lib/messages/body.ts) but full attachment content rather than a byte count.
 */
export async function loadExportBody(message: MessageRow, retentionDays: number, now = new Date()): Promise<ExportBody> {
  if (typeof message.bodyWithheld === "string") {
    return { status: "withheld", reason: withheldBodyMessage(message.bodyWithheld), html: null, text: null, attachments: [] };
  }
  if (message.bodyPurgedAt) {
    return {
      status: "shredded",
      reason: `Body shredded on ${formatDate(message.bodyPurgedAt)} under the organization's retention window. The key is gone; this content can't be recovered.`,
      html: null,
      text: null,
      attachments: [],
    };
  }
  if (!message.bodyKey) {
    return {
      status: "shredded",
      reason: "Body key is gone. This message predates encryption or was purged before it recorded a shred date.",
      html: null,
      text: null,
      attachments: [],
    };
  }

  const keptUntil = bodyKeptUntil(message.createdAt, retentionDays);
  if (keptUntil <= now) {
    return {
      status: "expired",
      reason: `Body passed the organization's retention window on ${formatDate(keptUntil)}. The retention sweep shreds keys past this point; the underlying content is effectively gone even where the row hasn't been swept yet.`,
      html: null,
      text: null,
      attachments: [],
    };
  }

  if (!message.storageKey) {
    return {
      status: "unavailable",
      reason: "Body has no storage location on record.",
      html: null,
      text: null,
      attachments: [],
    };
  }

  try {
    const body = await readBody(Buffer.from(message.bodyKey, "base64"), message.storageKey);
    return {
      status: "available",
      reason: "Body is within the organization's retention window.",
      html: body.html,
      text: body.text,
      attachments: body.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
      })),
    };
  } catch (err) {
    log.warn(`reading the body for ${message.id} failed: ${safeErrorMessage(err)}`);
    return {
      status: "unavailable",
      reason: "Body couldn't be read from storage. Retriable — this isn't a retention gap.",
      html: null,
      text: null,
      attachments: [],
    };
  }
}

/** Builds the .eml for one message. `body` says which content is real and which is a stand-in reason. */
export function buildMessageEml(message: MessageRow, domainName: string, body: ExportBody): string {
  const { envelope } = message;
  const outbound: OutboundMessage = {
    id: message.id,
    from: { name: envelope.fromName, address: envelope.from },
    to: envelope.to,
    cc: envelope.cc,
    bcc: [],
    replyTo: envelope.replyTo,
    subject: message.subject,
    html: body.status === "available" ? body.html : null,
    text: body.status === "available" ? body.text : `[${brand.name} export] ${body.reason}`,
    headers: {
      "Message-ID": `<${message.id}@${domainName}>`,
      [WIRE_HEADERS.messageId]: message.id,
      [WIRE_HEADERS.messageStatus]: message.status,
      [WIRE_HEADERS.bodyStatus]: body.status,
      [WIRE_HEADERS.bodyReason]: body.reason,
    },
    tags: message.tags,
    attachments: body.status === "available" ? body.attachments : [],
  };
  return buildMime(outbound, message.createdAt);
}
