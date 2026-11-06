import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { addressForwardTargets, addressForwards, addresses, domains, inboundMessages, type InboundMessageRow } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { escapeHtml } from "@/lib/format/html";
import { readInboundBody, readInboundObject } from "@/lib/inbound/attachments";
import { inboundHost } from "@/lib/inbound/records";
import { replyHeaders } from "@/lib/inbound/threading";
import { acceptForward } from "@/lib/messages/create";
import { notifyQueued } from "@/lib/messages/queue";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";
import type { SendEmailRequest } from "@/lib/schemas/email";
import { assertCanForward, forwardStopUrl } from "./forward-targets";
import { mayForward } from "./forward";
import { replyTarget } from "./reply";

const log = logger.child("addresses:forward");

/** Tries a forward gets when storage or the database fails under it, before it's marked failed. */
export const MAX_FORWARD_ATTEMPTS = 5;

/** The original sender's name, or their address, made safe for a display name. */
function senderLabel(message: Pick<InboundMessageRow, "fromName" | "fromAddress">): string {
  const name = (message.fromName ?? "").replace(/[\x00-\x1F\x7F"<>\\]+/g, " ").replace(/\s+/g, " ").trim();
  return (name || message.fromAddress).slice(0, 100);
}

function forwardSubject(subject: string): string {
  const flat = subject.replace(/[\x00-\x1F\x7F\u0085\u2028\u2029]+/g, " ").trim();
  return (flat || "(no subject)").slice(0, 998);
}

/** The forward as a send request: from the address, Reply-To the sender, threaded on the original. */
export function buildForward(input: {
  message: Pick<InboundMessageRow, "fromName" | "fromAddress" | "subject" | "headers" | "messageId">;
  body: { text: string | null; html: string | null };
  attachments: { filename: string; content: string; content_type: string }[];
  address: string;
  to: string;
  stopUrl: string;
}): SendEmailRequest {
  const { message, body, address, stopUrl } = input;
  const line = `Forwarded from ${message.fromAddress} by ${address}.`;
  const textFooter = `-- \n${line}\nStop these forwards: ${stopUrl}\n`;
  const htmlFooter = `<hr><p style="font-size:12px;color:#666">${escapeHtml(line)} <a href="${escapeHtml(stopUrl)}">Stop these forwards</a></p>`;
  const html = body.html === null ? undefined : /<\/body>/i.test(body.html) ? body.html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${htmlFooter}</body>`) : `${body.html}${htmlFooter}`;
  // Without a text part of its own, the text is derived from the html, footer included.
  const text = body.text !== null ? `${body.text}\n\n${textFooter}` : html === undefined ? textFooter : undefined;
  return {
    from: `"${senderLabel(message)} via ${address}" <${address}>`,
    to: [input.to],
    reply_to: [replyTarget(message)],
    subject: forwardSubject(message.subject),
    html,
    text,
    attachments: input.attachments.length > 0 ? input.attachments : undefined,
    headers: {
      ...replyHeaders(message),
      "List-Unsubscribe": `<${stopUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tags: ["forward"],
  };
}

async function settle(id: string, values: Partial<typeof addressForwards.$inferInsert>): Promise<void> {
  await db
    .update(addressForwards)
    .set({ ...values, updatedAt: await dbNow() })
    .where(eq(addressForwards.id, id));
}

/** Sends one queued forward. Never throws. */
export async function sendForward(forwardId: string): Promise<void> {
  const [found] = await db
    .select({
      forward: addressForwards,
      target: addressForwardTargets,
      address: addresses,
      inbound: inboundMessages,
      domainName: domains.name,
      inboundSubdomain: domains.inboundSubdomain,
    })
    .from(addressForwards)
    .innerJoin(addressForwardTargets, eq(addressForwardTargets.id, addressForwards.targetId))
    .innerJoin(addresses, eq(addresses.id, addressForwards.addressId))
    .innerJoin(inboundMessages, eq(inboundMessages.id, addressForwards.inboundMessageId))
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .where(eq(addressForwards.id, forwardId))
    .limit(1);
  if (!found || found.forward.status !== "pending") return;
  const { forward, target, address, inbound } = found;

  if (target.status !== "confirmed") return settle(forward.id, { status: "skipped", reason: `target_${target.status}` });
  if (!mayForward(inbound.verdicts)) return settle(forward.id, { status: "skipped", reason: "flagged" });

  const host = inboundHost(found.domainName, found.inboundSubdomain);
  const from = `${address.localPart}@${host}`;
  let request: SendEmailRequest;
  try {
    await assertCanForward(address, { name: found.domainName, inboundSubdomain: found.inboundSubdomain }, await dbNow());
    const body = await readInboundBody(inbound);
    const attachments = await Promise.all(
      inbound.attachments
        .filter((attachment) => attachment.storageKey !== null)
        .map(async (attachment) => ({
          filename: attachment.filename,
          content: (await readInboundObject(inbound, attachment.storageKey!)).toString("base64"),
          content_type: attachment.contentType,
        })),
    );
    request = buildForward({ message: inbound, body, attachments, address: from, to: target.email, stopUrl: forwardStopUrl(target.id) });
  } catch (error) {
    return fail(forward, target.id, error);
  }

  try {
    const { message, replayed } = await acceptForward(address.organizationId, address.apiKeyId, request, `forward:${forward.id}`, address.domainId);
    const now = await dbNow();
    await db.transaction(async (tx) => {
      await tx.update(addressForwards).set({ status: "sent", messageId: message.id, reason: null, updatedAt: now }).where(eq(addressForwards.id, forward.id));
      if (replayed) return;
      await tx
        .update(addressForwardTargets)
        .set({ forwardedCount: sql`${addressForwardTargets.forwardedCount} + 1`, lastForwardedAt: now, updatedAt: now })
        .where(eq(addressForwardTargets.id, target.id));
      await tx.update(addresses).set({ forwardedCount: sql`${addresses.forwardedCount} + 1` }).where(eq(addresses.id, address.id));
    });
    if (!replayed) await notifyQueued(message.id).catch(() => {});
  } catch (error) {
    await fail(forward, target.id, error);
  }
}

/** An API refusal is final and shown on the target. Anything else is retried, up to a ceiling. */
async function fail(forward: { id: string; attempts: number }, targetId: string, error: unknown): Promise<void> {
  const now = await dbNow();
  if (error instanceof ApiError) {
    const skipped = error.code === "address_inactive";
    await settle(forward.id, { status: skipped ? "skipped" : "failed", reason: error.code, attempts: forward.attempts + 1 });
    if (!skipped) {
      await db
        .update(addressForwardTargets)
        .set({ lastFailure: { code: error.code, message: error.message, at: now.toISOString() }, updatedAt: now })
        .where(eq(addressForwardTargets.id, targetId));
    }
    return;
  }
  const attempts = forward.attempts + 1;
  log.warn(`forward ${forward.id} failed (attempt ${attempts}): ${safeErrorMessage(error)}`);
  await settle(forward.id, attempts >= MAX_FORWARD_ATTEMPTS ? { status: "failed", reason: "error", attempts } : { attempts });
}

/** Queued forwards, oldest first. Polled by the worker. */
export async function pendingForwards(limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: addressForwards.id })
    .from(addressForwards)
    .where(eq(addressForwards.status, "pending"))
    .orderBy(asc(addressForwards.attempts), asc(addressForwards.createdAt))
    .limit(limit);
  return rows.map((row) => row.id);
}
