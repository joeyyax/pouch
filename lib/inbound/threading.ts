import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "@/lib/db";
import { inboundMessages, messages } from "@/lib/db/schema";
import { newId } from "@/lib/ids";

/** Case-insensitive header lookup: providers disagree on key case (`References` vs `references`). */
export function header(headers: Record<string, string>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

/**
 * Every `Message-Id`-shaped token in a header value, without angle brackets or folded whitespace.
 * `References` carries the chain oldest first, ending with the immediate parent.
 */
export function messageIdTokens(raw: string): string[] {
  const bracketed = raw.match(/<[^<>]+>/g);
  const candidates = bracketed ?? [raw];
  return candidates
    .map((id) => id.replace(/\s+/g, "").replace(/^</, "").replace(/>$/, ""))
    .filter((id) => id.length > 0);
}

/** The ids a message names as its ancestors, nearest first, lowercased. */
export function ancestorKeys(inReplyTo: string | null, headers: Record<string, string>): string[] {
  const references = header(headers, "references");
  const ordered = [...(inReplyTo ? messageIdTokens(inReplyTo) : []), ...(references ? messageIdTokens(references).reverse() : [])];
  return [...new Set(ordered.map((id) => id.toLowerCase()))];
}

/** How `inbound_messages_message_key_idx` spells a stored `Message-Id`. */
const messageKey = sql`lower(btrim(${inboundMessages.messageId}, '<> '))`;

async function threadOfAncestors(executor: Executor, organizationId: string, keys: string[]): Promise<string | null> {
  if (keys.length === 0) return null;
  const [found] = await executor
    .select({ threadId: inboundMessages.threadId })
    .from(inboundMessages)
    .where(and(eq(inboundMessages.organizationId, organizationId), inArray(messageKey, keys)))
    .orderBy(desc(inboundMessages.receivedAt))
    .limit(1);
  return found?.threadId ?? null;
}

/**
 * The thread an arriving message joins: that of any stored message it names in `In-Reply-To` or
 * `References`, else that of the inbound message a matched outbound reply answered, else a new one.
 */
export async function threadFor(
  executor: Executor,
  organizationId: string,
  item: { inReplyTo: string | null; headers: Record<string, string> },
  outboundMessageId: string | null,
): Promise<string> {
  const direct = await threadOfAncestors(executor, organizationId, ancestorKeys(item.inReplyTo, item.headers));
  if (direct) return direct;

  if (outboundMessageId) {
    const [sent] = await executor
      .select({ envelope: messages.envelope })
      .from(messages)
      .where(and(eq(messages.organizationId, organizationId), eq(messages.id, outboundMessageId)))
      .limit(1);
    const sentHeaders = sent?.envelope.headers ?? {};
    const viaReply = await threadOfAncestors(executor, organizationId, ancestorKeys(header(sentHeaders, "in-reply-to"), sentHeaders));
    if (viaReply) return viaReply;
  }

  return newId("thread");
}

/** At most this many ids carried forward in a reply's `References`, keeping the header short. */
const MAX_REFERENCES = 20;

/** `In-Reply-To` and `References` for a reply to `parent`. Empty when the parent has no `Message-Id`. */
export function replyHeaders(parent: { messageId: string | null; headers: Record<string, string> }): Record<string, string> {
  const own = parent.messageId ? messageIdTokens(parent.messageId)[0] : undefined;
  if (!own) return {};
  const references = header(parent.headers, "references");
  const chain = [...(references ? messageIdTokens(references) : []).filter((id) => id !== own), own].slice(-MAX_REFERENCES);
  return { "In-Reply-To": `<${own}>`, References: chain.map((id) => `<${id}>`).join(" ") };
}
