import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, type MessageRow } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import type { KeyMode } from "@/lib/api/keys";
import { retentionDaysFor } from "@/lib/organizations";
import type { StoredBody } from "@/lib/storage/bodies";
import { sendEmailSchema, type SendEmailRequest } from "@/lib/schemas/email";
import { bodyGoneFromRow, loadStoredBody, withheldSentence, type BodyGone } from "./body";
import { acceptResend, type AcceptedMessage } from "./create";
import { notifyQueued } from "./queue";
import { findMessage } from "./read";
import { isDomainUnsubscribed } from "@/lib/lists/unsubscribe";

/** Who is resending: an API key, or a dashboard session with no key. */
export interface ResendCaller {
  organizationId: string;
  apiKeyId: string | null;
  domainIds: string[];
}

export interface ResendRefusal {
  reason: "withheld" | "shredded" | "expired" | "unsubscribed";
  /** One sentence naming why. */
  message: string;
  ended_at: string | null;
}

/** Why a message can't be resent, from its row alone. Null when storage has to be asked. */
export function resendRefusal(
  message: Pick<MessageRow, "id" | "bodyWithheld" | "bodyPurgedAt" | "bodyKey" | "createdAt">,
  retentionDays: number,
  now = new Date(),
): ResendRefusal | null {
  const gone = bodyGoneFromRow(message, retentionDays, now);
  return gone ? refusalFor(gone) : null;
}

function refusalFor(gone: BodyGone): ResendRefusal | null {
  if (gone.state === "withheld") {
    return { reason: "withheld", message: `This message can't be resent. ${withheldSentence(gone.reason)}`, ended_at: null };
  }
  if (gone.state === "purged") {
    return gone.purgedAt
      ? {
          reason: "shredded",
          message: "This message can't be resent. Its body was shredded past the retention window.",
          ended_at: gone.purgedAt.toISOString(),
        }
      : { reason: "shredded", message: "This message can't be resent. It predates body encryption, so its body can't be read.", ended_at: null };
  }
  if (gone.state === "expired") {
    return { reason: "expired", message: "This message can't be resent. Its body is past the retention window.", ended_at: gone.keptUntil.toISOString() };
  }
  return null;
}

/** A bulk original goes only to recipients who haven't unsubscribed from its domain since. */
async function refuseUnsubscribed(original: MessageRow): Promise<void> {
  if (!original.batchId) return;
  for (const address of [...original.envelope.to, ...original.envelope.cc, ...original.envelope.bcc]) {
    if (await isDomainUnsubscribed(original.domainId, address)) {
      throw new ApiError("resend_not_allowed", `This message can't be resent. ${address} unsubscribed from this domain's bulk mail.`, {
        detail: { reason: "unsubscribed", ended_at: null },
      });
    }
  }
}

/** The original's send, rebuilt as a request for the accept path. */
function resendRequest(original: MessageRow, body: StoredBody): SendEmailRequest {
  const { envelope } = original;
  return sendEmailSchema.parse({
    from: envelope.fromName ? `${envelope.fromName} <${envelope.from}>` : envelope.from,
    to: envelope.to,
    cc: envelope.cc.length > 0 ? envelope.cc : undefined,
    bcc: envelope.bcc.length > 0 ? envelope.bcc : undefined,
    reply_to: envelope.replyTo.length > 0 ? envelope.replyTo : undefined,
    subject: original.subject,
    html: body.html ?? undefined,
    // A generated text part is generated again from the same html.
    text: body.textGenerated ? undefined : (body.text ?? undefined),
    headers: Object.keys(envelope.headers).length > 0 ? envelope.headers : undefined,
    tags: original.tags.length > 0 ? original.tags : undefined,
    attachments:
      body.attachments.length > 0
        ? body.attachments.map((attachment) => ({ filename: attachment.filename, content: attachment.content, content_type: attachment.contentType }))
        : undefined,
    layout: original.layout ? (original.layoutOverrides ?? true) : undefined,
  });
}

/**
 * Sends `original` again as a new message linked to it, through the accept path. The copy keeps
 * the original's mode. Throws `resend_not_allowed` or `storage_unavailable` when the body can't be read.
 */
export async function resendMessage(caller: ResendCaller, original: MessageRow, idempotencyKey: string | null): Promise<AcceptedMessage> {
  const mode: KeyMode = original.testMode ? "test" : "live";
  return acceptResend({
    organizationId: caller.organizationId,
    apiKeyId: caller.apiKeyId,
    mode,
    domainIds: caller.domainIds,
    original,
    idempotencyKey,
    loadRequest: async () => {
      await refuseUnsubscribed(original);
      const stored = await loadStoredBody(original, await retentionDaysFor(original.organizationId));
      if (stored.state === "available") return resendRequest(original, stored.body);
      const refusal = refusalFor(stored);
      if (refusal) {
        throw new ApiError("resend_not_allowed", refusal.message, { detail: { reason: refusal.reason, ended_at: refusal.ended_at } });
      }
      throw new ApiError("storage_unavailable", "Storage didn't answer, so this message's body couldn't be read. Retry the resend.");
    },
  });
}

/** A dashboard resend: any message in the organization, sent with no key. */
export async function resendFromDashboard(organizationId: string, id: string): Promise<AcceptedMessage> {
  const original = await findMessage({ organizationId, domainIds: [] }, id);
  const { message, replayed } = await resendMessage({ organizationId, apiKeyId: null, domainIds: [] }, original, null);
  if (!replayed) await notifyQueued(message.id).catch(() => {});
  return { message, replayed };
}

export interface ResendCopy {
  id: string;
  status: MessageRow["status"];
  created_at: string;
}

/** The copies resent from each message, oldest first. */
export async function resendCopies(organizationId: string, messageIds: string[]): Promise<Map<string, ResendCopy[]>> {
  const byMessage = new Map<string, ResendCopy[]>(messageIds.map((id) => [id, []]));
  if (messageIds.length === 0) return byMessage;
  const rows = await db
    .select({ id: messages.id, status: messages.status, createdAt: messages.createdAt, resentFrom: messages.resentFrom })
    .from(messages)
    .where(and(eq(messages.organizationId, organizationId), inArray(messages.resentFrom, messageIds)))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  for (const row of rows) {
    if (row.resentFrom) byMessage.get(row.resentFrom)?.push({ id: row.id, status: row.status, created_at: row.createdAt.toISOString() });
  }
  return byMessage;
}
