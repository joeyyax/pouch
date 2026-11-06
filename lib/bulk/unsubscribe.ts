/**
 * Unsubscribe redemption for a batch sent to inline `recipients` (no list — see create.ts).
 * There's no membership row to key a token off, so the token signs the *message* id instead
 * (lib/lists/tokens.ts's signer is generic over any opaque id) and redemption resolves the
 * recipient and domain from that message. With no list behind it, the only scope that makes
 * sense is the domain: an inline batch's one-click unsubscribe stops all mail from that domain,
 * the same as choosing "stop all bulk mail" on a list-backed one.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, domainUnsubscribes, messages } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { enqueueDomainScopedWebhookEvent } from "@/lib/webhooks/dispatch";
import { signSubjectToken, verifySubjectToken } from "@/lib/lists/tokens";

export class InvalidUnsubscribeTokenError extends Error {
  constructor() {
    super("This unsubscribe link is invalid or has expired.");
    this.name = "InvalidUnsubscribeTokenError";
  }
}

export function signBatchUnsubscribeToken(messageId: string): string {
  return signSubjectToken(messageId, "unsubscribe");
}

export interface RedeemResult {
  domain_name: string;
}

/** What an inline-batch unsubscribe link names, read without redeeming it. Null when forged or gone. */
export interface MessageUnsubscribeLink {
  address: string;
  domainId: string;
  domainName: string;
  domainStopped: boolean;
}

export async function readMessageUnsubscribeToken(token: string): Promise<MessageUnsubscribeLink | null> {
  const messageId = verifySubjectToken(token, "unsubscribe");
  if (!messageId) return null;
  const [row] = await db
    .select({ domainId: messages.domainId, domainName: domains.name, to: messages.recipients })
    .from(messages)
    .innerJoin(domains, eq(domains.id, messages.domainId))
    .where(eq(messages.id, messageId))
    .limit(1);
  const address = row?.to[0];
  if (!row || !address) return null;
  const [stopped] = await db
    .select({ id: domainUnsubscribes.id })
    .from(domainUnsubscribes)
    .where(and(eq(domainUnsubscribes.domainId, row.domainId), eq(domainUnsubscribes.address, address)))
    .limit(1);
  return { address, domainId: row.domainId, domainName: row.domainName, domainStopped: Boolean(stopped) };
}

export async function redeemMessageUnsubscribeToken(token: string): Promise<RedeemResult> {
  const messageId = verifySubjectToken(token, "unsubscribe");
  if (!messageId) throw new InvalidUnsubscribeTokenError();

  const [row] = await db
    .select({
      organizationId: domains.organizationId,
      domainId: messages.domainId,
      domainName: domains.name,
      to: messages.recipients,
    })
    .from(messages)
    .innerJoin(domains, eq(domains.id, messages.domainId))
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!row) throw new InvalidUnsubscribeTokenError();

  const address = row.to[0];
  if (!address) throw new InvalidUnsubscribeTokenError();

  // Reuses the same table a list-backed unsubscribe writes to — lib/lists/unsubscribe.ts.
  await db
    .insert(domainUnsubscribes)
    .values({ id: newId("domainUnsubscribe"), organizationId: row.organizationId, domainId: row.domainId, address })
    .onConflictDoNothing();

  await enqueueDomainScopedWebhookEvent(row.organizationId, {
    eventId: newId("event"),
    eventType: "email.unsubscribed",
    occurredAt: await dbNow(),
    domainId: row.domainId,
    data: { list_id: null, address, scope: "domain" },
  }).catch(() => {});

  return { domain_name: row.domainName };
}
