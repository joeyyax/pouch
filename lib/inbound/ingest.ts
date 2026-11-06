import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, inboundMessages, messages, providers } from "@/lib/db/schema";
import type { InboundMessageRow } from "@/lib/db/schema";
import { admitToAddresses, claimRecipients, enqueueAddressDeliveries, mayDeliver } from "@/lib/addresses/route";
import { publishAddressMail } from "@/lib/addresses/inbox";
import { enqueueForwards } from "@/lib/addresses/forward";
import { REPORT_ROUTE_ID } from "@/lib/dmarc/host";
import { receiveReportMail } from "@/lib/dmarc/receive";

type DomainRow = typeof domains.$inferSelect;
import { adapterFor } from "@/lib/providers";
import { isFeatureEnabled } from "@/lib/features";
import { readSetting } from "@/lib/settings/values";
import { newId } from "@/lib/ids";
import { newMessageKey } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { readDomainEndpoint } from "@/lib/webhooks/endpoints";
import type { NormalizedInboundMessage, ReceivedMail, SignedRequest } from "@/lib/providers/adapters/types";
import { newInboundStorageKey, purgeInboundObjects, writeInboundAttachments, writeInboundBody, writeInboundRaw, type InboundBody } from "./attachments";
import { parseRawInbound } from "./mime";
import { inboundHost } from "./records";
import { enqueueInboundDelivery } from "./deliver";
import { ancestorKeys, threadFor } from "./threading";

const log = logger.child("inbound:ingest");

/** Everything before the first `@` of a `Message-Id` token, or the whole token if it has no host. */
function localPart(token: string): string {
  return token.split("@")[0] ?? token;
}

/**
 * Best-effort match from an inbound reply to the outbound message it replies to. Pouch doesn't
 * mint its own `Message-Id` header today, so this matches against `messages.provider_message_id`
 * — most providers set `Message-Id` from their own id, with or without an `@host` suffix. A
 * provider that formats it differently simply finds no match, which leaves `outboundMessageId`
 * null rather than guessing wrong.
 *
 * A stored id that carries a host is compared whole, so two sends whose ids share a local part
 * can't be confused. A stored id without one can only be the token's local part, so that's what
 * it's compared against.
 *
 * Tries `In-Reply-To` first, then falls back to `References` (last entry first, since that's the
 * immediate parent) — some clients mangle or drop `In-Reply-To` on reply but still carry the
 * chain in `References`. Matching is case-insensitive: id case isn't a signal, and some clients
 * re-case headers on the way through.
 */
async function matchOutboundMessage(
  organizationId: string,
  inReplyTo: string | null,
  headers: Record<string, string>,
): Promise<string | null> {
  const tokens = ancestorKeys(inReplyTo, headers);
  if (tokens.length === 0) return null;

  const candidates = [...new Set(tokens.flatMap((token) => [token, localPart(token)]))];
  const rows = await db
    .select({ id: messages.id, providerMessageId: messages.providerMessageId })
    .from(messages)
    .where(and(eq(messages.organizationId, organizationId), inArray(sql`lower(${messages.providerMessageId})`, candidates)));
  if (rows.length === 0) return null;

  // Several tokens can each match a different row; prefer the earliest-tried one — In-Reply-To
  // over References, and within References the immediate parent over older ancestors. Within one
  // token, a whole-id match beats the host-less fallback.
  const byStoredId = new Map(rows.map((row) => [row.providerMessageId?.toLowerCase(), row.id]));
  for (const token of tokens) {
    const match = byStoredId.get(token) ?? byStoredId.get(localPart(token));
    if (match) return match;
  }
  return null;
}

export interface IngestResult {
  /** Includes mail an address dropped: the provider is told it landed either way. */
  accepted: number;
  duplicates: number;
}

/** Thrown inside the storing transaction to undo a retried delivery's counts. */
class DuplicateDelivery extends Error {}

/**
 * Persists every normalized message from one inbound callback and enqueues its webhook
 * deliveries in the same transaction. A provider id already seen for this domain is a duplicate
 * delivery, not a new message — inbound_messages_provider_message_idx makes it one, and nothing
 * is counted or re-enqueued for it. Mail only addresses claim, none of which takes it, is counted
 * on them and dropped without being stored.
 */
export async function ingestInboundMessages(domain: DomainRow, parsed: NormalizedInboundMessage[]): Promise<IngestResult> {
  const result: IngestResult = { accepted: 0, duplicates: 0 };
  if (parsed.length === 0) return result;

  const endpoint = await readDomainEndpoint(domain.organizationId, domain.id);
  const [now, ceiling] = await Promise.all([dbNow(), readSetting("inbound_retention_max_days")]);
  const expiresAt = new Date(now.getTime() + Math.min(domain.inboundRetentionDays, ceiling) * 24 * 60 * 60 * 1000);

  for (const item of parsed) {
    const claim = await claimRecipients(domain, item.to);
    if (!claim.unclaimed && !mayDeliver(claim, item.verdicts, now)) {
      await db.transaction((tx) => admitToAddresses(tx, claim, item.verdicts));
      result.accepted += 1;
      continue;
    }

    // A message that failed a virus scan keeps its metadata and none of its content.
    const quarantined = item.verdicts?.virus === "fail";
    const body: InboundBody = quarantined ? { text: null, html: null } : { text: item.text, html: item.html };
    const sealed = quarantined ? null : newMessageKey();
    const storageKey = sealed ? newInboundStorageKey() : null;
    if (sealed && storageKey) await writeInboundBody(sealed.key, storageKey, body);
    const attachments = await writeInboundAttachments(storageKey, sealed?.key ?? null, item.attachments);
    const rawStorageKey = sealed && storageKey && item.raw ? await writeInboundRaw(storageKey, sealed.key, item.raw) : null;
    const outboundMessageId = await matchOutboundMessage(domain.organizationId, item.inReplyTo, item.headers);
    const discardObjects = async () => {
      if (!storageKey) return;
      await purgeInboundObjects({ attachments, rawStorageKey, storageKey }).catch((err) =>
        log.warn(`cleaning up objects for an unstored inbound message failed: ${safeErrorMessage(err)}`),
      );
    };

    let row: InboundMessageRow | null;
    try {
      row = await db.transaction(async (tx) => {
        const delivered = await admitToAddresses(tx, claim, item.verdicts);
        if (!claim.unclaimed && delivered.length === 0) return null;
        const threadId = await threadFor(tx, domain.organizationId, item, outboundMessageId);

        const [inserted] = await tx
          .insert(inboundMessages)
          .values({
            id: newId("inbound"),
            organizationId: domain.organizationId,
            domainId: domain.id,
            providerMessageId: item.providerMessageId,
            fromAddress: item.from.address,
            fromName: item.from.name,
            to: item.to,
            subject: item.subject,
            bodyKey: sealed?.encoded ?? null,
            storageKey,
            headers: item.headers,
            messageId: item.messageId,
            inReplyTo: item.inReplyTo,
            outboundMessageId,
            attachments,
            rawStorageKey,
            addressIds: delivered.map((address) => address.id),
            threadId,
            verdicts: item.verdicts,
            receivedAt: now,
            expiresAt,
          })
          .onConflictDoNothing({
            target: [inboundMessages.domainId, inboundMessages.providerMessageId],
            where: sql`${inboundMessages.providerMessageId} is not null`,
          })
          .returning();
        if (!inserted) throw new DuplicateDelivery();

        if (claim.unclaimed && endpoint && !endpoint.disabledAt) await enqueueInboundDelivery(endpoint, inserted, body, tx);
        await enqueueAddressDeliveries(tx, domain, inserted, body, delivered);
        await enqueueForwards(tx, inserted, delivered);
        return inserted;
      });
    } catch (err) {
      await discardObjects();
      if (!(err instanceof DuplicateDelivery)) throw err;
      result.duplicates += 1;
      continue;
    }

    if (!row) await discardObjects();
    else await publishAddressMail(domain.organizationId, row.addressIds);
    result.accepted += 1;
  }

  return result;
}

export interface ReceiveOutcome {
  /** False for anything that isn't a domain currently able to accept this callback — unknown
   * domain, adapter mismatch, inbound disabled, an adapter with no inbound support, or a signature
   * that doesn't check out. Deliberately one outcome for all of these (lib/webhooks/receive.ts
   * does the same for outbound events): a prober must not learn which domains exist from the
   * response. */
  verified: boolean;
  result?: IngestResult;
}

/**
 * Handles one provider inbound callback for a domain. Mirrors lib/webhooks/receive.ts's shape
 * for outbound events: the path names the domain, so the receiver knows the organization and
 * verification settings without scanning, and a callback signed for one domain can never apply
 * to another.
 */
export async function receiveInbound(adapter: string, domainId: string, request: SignedRequest): Promise<ReceiveOutcome> {
  const [row] = await db
    .select({ domain: domains, provider: providers })
    .from(domains)
    .innerJoin(providers, eq(providers.id, domains.providerId))
    .where(and(eq(domains.id, domainId), eq(providers.adapter, adapter)))
    .limit(1);

  if (!row || !row.domain.inboundEnabled) {
    log.warn(`rejected an inbound callback for an unknown or inbound-disabled domain: ${adapter}/${domainId}`);
    return { verified: false };
  }

  const client = adapterFor(row.provider);
  if (!client.inbound?.verify || !client.inbound.parse) {
    log.warn(`rejected an inbound callback for ${domainId}: ${adapter} has no inbound support`);
    return { verified: false };
  }

  if (!client.inbound.verify(request, row.domain.inboundProviderSettings)) {
    log.warn(`rejected an inbound callback for ${domainId}: the signature doesn't match the domain's key`);
    return { verified: false };
  }

  const parsed = client.inbound.parse(request);
  if (!(await isFeatureEnabled("inbound"))) {
    log.warn(`dropped ${parsed.length} inbound message(s) for ${domainId}: inbound is turned off`);
    return { verified: true, result: { accepted: parsed.length, duplicates: 0 } };
  }
  const result = await ingestInboundMessages(row.domain, parsed);
  return { verified: true, result };
}

async function alreadyStored(domainId: string, providerMessageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: inboundMessages.id })
    .from(inboundMessages)
    .where(and(eq(inboundMessages.domainId, domainId), eq(inboundMessages.providerMessageId, providerMessageId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Handles mail a provider announced on its event channel. The provider is the one whose callback
 * verified, and the domain has to be bound to it with inbound on — a domain id echoed back by
 * another provider's routing, or one that turned inbound off since, is dropped. Either way the
 * provider's own copy is deleted once it's no longer needed.
 */
export async function receiveProviderMail(providerId: string, mail: ReceivedMail): Promise<IngestResult> {
  if (mail.domainId === REPORT_ROUTE_ID) return receiveReportMail(providerId, mail);

  // The provider's copy stays for its bucket's expiry rule, so it can be replayed once inbound is back on.
  if (!(await isFeatureEnabled("inbound"))) {
    log.warn(`left ${mail.providerMessageId} unread at the provider: inbound is turned off`);
    return { accepted: 1, duplicates: 0 };
  }

  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, mail.domainId), eq(domains.providerId, providerId)))
    .limit(1);

  let result: IngestResult = { accepted: 0, duplicates: 0 };
  if (!domain || !domain.inboundEnabled) {
    log.warn(`dropped received mail for an unknown or inbound-disabled domain: ${providerId}/${mail.domainId}`);
  } else if (await alreadyStored(domain.id, mail.providerMessageId)) {
    // A retry of an announcement already ingested, whose copy the first attempt deleted.
    result = { accepted: 0, duplicates: 1 };
  } else {
    const raw = await mail.read();
    if (!raw) {
      log.warn(`the provider's copy of ${mail.providerMessageId} is gone and nothing was stored from it`);
      return result;
    }
    const host = inboundHost(domain.name, domain.inboundSubdomain);
    const parsed = await parseRawInbound(raw, { recipients: mail.recipients, host, providerMessageId: mail.providerMessageId, verdicts: mail.verdicts });
    result = await ingestInboundMessages(domain, [parsed]);
  }

  await mail.discard().catch((err) => log.warn(`deleting the provider's copy of ${mail.providerMessageId} failed: ${safeErrorMessage(err)}`));
  return result;
}
