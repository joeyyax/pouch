/**
 * POST /v1/batches (#7). Turns a list, or an inline recipient array, into one message row per
 * deliverable recipient — same table, same worker, same events as a transactional send. Reads
 * `domains` and `providers` directly rather than through `lib/domains`, the same
 * boundary `lib/lists/index.ts` draws.
 */
import { assertFeatureEnabled } from "@/lib/features";
import { and, count, eq } from "drizzle-orm";
import { mapBounded } from "@/lib/async";
import { db } from "@/lib/db";
import { domains, listMemberships, lists, messageEvents, messages, providers } from "@/lib/db/schema";
import type { MessageEnvelope, MessageRow } from "@/lib/db/schema";
import { batches } from "@/lib/db/schema/lists";
import type { BatchRow } from "@/lib/db/schema/lists";
import { domainOf, isEmailAddress, normalizeAddress, parseAddress } from "@/lib/addresses";
import { ApiError } from "@/lib/api/errors";
import { assertNotSuspended } from "@/lib/suspension";
import { keyCanAccessDomain } from "@/lib/api/keys";
import { newMessageKey } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { assertBulkAllowed } from "./allowed";
import { htmlToText } from "@/lib/messages/html-to-text";
import { bodyBytes } from "@/lib/messages/size";
import { findSuppressed } from "@/lib/messages/suppression";
import { publishMessageUpdate } from "@/lib/messages/updates";
import { notifyQueued } from "@/lib/messages/queue";
import { newStorageKey, purgeBody, writeBody } from "@/lib/storage/bodies";
import { logger } from "@/lib/logger";
import { indexMessages } from "@/lib/search";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { currentRequestId } from "@/lib/api/request-context";
import type { CreateBatchRequest } from "@/lib/schemas/batch";
import { renderHtmlTemplate, renderTemplate } from "./template";
import { unsubscribeHeaders } from "./headers";
import { signSubjectToken } from "@/lib/lists/tokens";
import { signBatchUnsubscribeToken } from "./unsubscribe";
import { domainUnsubscribedAmong } from "@/lib/lists/unsubscribe";
import { serializeBatch, type SerializedBatch } from "./serialize";

const log = logger.child("bulk:create");

/** Messages per insert while accepting a batch. */
const INSERT_CHUNK = 250;
/** Bodies written to storage at once. */
const BODY_WRITES = 16;


/** Deliverable candidate: an address plus what a batch owes it — attributes and, when the
 * batch drew from a list, the membership id an unsubscribe token signs and its status. */
interface Candidate {
  address: string;
  attributes: Record<string, string>;
  membershipId: string | null;
  /** Null for an inline recipient, which has no membership to be anything but deliverable. */
  membershipStatus: "pending" | "subscribed" | "unsubscribed" | null;
}

export interface BatchCaller {
  organizationId: string;
  domainIds: string[];
  apiKeyId: string | null;
  mode: "live" | "test";
}

async function resolveDomain(caller: BatchCaller, fromAddress: string) {
  const name = domainOf(fromAddress);
  const [found] = await db
    .select({ domain: domains, providerAdapter: providers.adapter })
    .from(domains)
    .innerJoin(providers, eq(providers.id, domains.providerId))
    .where(and(eq(domains.organizationId, caller.organizationId), eq(domains.name, name)))
    .limit(1);

  if (!found) {
    throw new ApiError("domain_not_verified", `Domain ${name} hasn't been added. Add it with POST /v1/domains.`, {
      field: "from",
      detail: { exists: false },
    });
  }
  if (!keyCanAccessDomain(caller, found.domain.id)) {
    throw new ApiError("key_not_scoped", `This key can't send from ${name}.`, { field: "from" });
  }
  if (found.domain.status !== "verified") {
    throw new ApiError("domain_not_verified", `Domain ${name} isn't verified. Add the listed DNS records and verify.`, {
      field: "from",
      detail: { records: found.domain.dnsRecords },
    });
  }
  assertBulkAllowed(found.domain, found.providerAdapter, name);
  return { domain: found.domain, providerAdapter: found.providerAdapter };
}

async function candidatesFromList(organizationId: string, listId: string, domainId: string): Promise<Candidate[]> {
  const [list] = await db
    .select()
    .from(lists)
    .where(and(eq(lists.organizationId, organizationId), eq(lists.id, listId)))
    .limit(1);
  if (!list) throw new ApiError("not_found", `No list with id ${listId}.`, { field: "list" });
  if (list.domainId !== domainId) {
    throw new ApiError("validation_failed", `List ${listId} isn't on the sending domain.`, { field: "list" });
  }

  const members = await db.select().from(listMemberships).where(eq(listMemberships.listId, list.id));
  return members.map((member) => ({
    address: member.address,
    attributes: member.attributes,
    membershipId: member.id,
    membershipStatus: member.status,
  }));
}

function candidatesFromRecipients(recipients: { address: string; attributes?: Record<string, string> }[]): Candidate[] {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const recipient of recipients) {
    const address = normalizeAddress(recipient.address);
    if (!isEmailAddress(address)) {
      throw new ApiError("validation_failed", `"${recipient.address}" isn't a valid address.`, { field: "recipients" });
    }
    if (seen.has(address)) continue;
    seen.add(address);
    candidates.push({ address, attributes: recipient.attributes ?? {}, membershipId: null, membershipStatus: null });
  }
  return candidates;
}

/** True when a list-backed candidate is deliverable now: subscribed. Inline recipients have no membership to check. */
function membershipDeliverable(candidate: Candidate): boolean {
  return candidate.membershipStatus === null || candidate.membershipStatus === "subscribed";
}

export async function createBatch(caller: BatchCaller, request: CreateBatchRequest): Promise<SerializedBatch> {
  await assertNotSuspended(caller.organizationId);

  const from = parseAddress(request.from);
  if (!from) throw new ApiError("validation_failed", `Field "from" isn't a valid address.`, { field: "from" });

  const { domain } = await resolveDomain(caller, from.address);

  if (request.layout && !domain.layout) {
    throw new ApiError("validation_failed", `Domain ${domain.name} has no layout.`, { field: "layout" });
  }

  let candidates: Candidate[];
  if (request.list) {
    await assertFeatureEnabled("lists");
    candidates = await candidatesFromList(caller.organizationId, request.list, domain.id);
  } else if (request.recipients) {
    candidates = candidatesFromRecipients(request.recipients);
  } else {
    throw new ApiError("validation_failed", `Provide either "list" or "recipients".`, { field: "list" });
  }

  if (candidates.length === 0) {
    throw new ApiError("validation_failed", "No recipients to send to.", { field: request.list ? "list" : "recipients" });
  }

  const suppressed = new Set((await findSuppressed(caller.organizationId, candidates.map((c) => c.address))).map((row) => row.address));

  const unsubscribed = await domainUnsubscribedAmong(domain.id, candidates.map((c) => c.address));
  const deliverable: Candidate[] = [];
  let skippedCount = 0;
  for (const candidate of candidates) {
    if (!membershipDeliverable(candidate)) {
      skippedCount++;
      continue;
    }
    if (suppressed.has(candidate.address)) {
      skippedCount++;
      continue;
    }
    if (unsubscribed.has(normalizeAddress(candidate.address))) {
      skippedCount++;
      continue;
    }
    deliverable.push(candidate);
  }

  const batchId = newId("batch");
  const html = request.html ?? null;
  const textGenerated = request.text === undefined && html !== null;

  const createdMessageIds: string[] = [];
  const created: MessageRow[] = [];
  for (let i = 0; i < deliverable.length; i += INSERT_CHUNK) {
    const prepared = deliverable.slice(i, i + INSERT_CHUNK).map((candidate) => {
      const messageId = newId("message");
      const renderedHtml = html ? renderHtmlTemplate(html, candidate.attributes) : null;
      const renderedText = request.text !== undefined ? renderTemplate(request.text, candidate.attributes) : textGenerated && renderedHtml ? htmlToText(renderedHtml) : null;
      const token = candidate.membershipId ? signSubjectToken(candidate.membershipId, "unsubscribe") : signBatchUnsubscribeToken(messageId);
      const { key, encoded } = newMessageKey();
      return { candidate, messageId, renderedHtml, renderedText, headers: unsubscribeHeaders(token, domain.unsubscribeUrl), storageKey: newStorageKey(), key, encoded };
    });

    const stored = (
      await mapBounded(prepared, BODY_WRITES, async (item) => {
        try {
          await writeBody(item.key, item.storageKey, { html: item.renderedHtml, text: item.renderedText, textGenerated, attachments: [] });
          return item;
        } catch (err) {
          log.error(`couldn't store the body for batch ${batchId} recipient: ${safeErrorMessage(err)}`);
          return null;
        }
      })
    ).filter((item) => item !== null);
    skippedCount += prepared.length - stored.length;
    if (stored.length === 0) continue;

    let rows: MessageRow[];
    try {
      rows = await db
        .insert(messages)
        .values(
          stored.map((item) => ({
            id: item.messageId,
            organizationId: caller.organizationId,
            domainId: domain.id,
            apiKeyId: caller.apiKeyId,
            batchId,
            status: "queued" as const,
            fromAddress: from.address,
            recipients: [item.candidate.address],
            subject: renderTemplate(request.subject, item.candidate.attributes),
            envelope: {
              from: from.address,
              fromName: from.name,
              to: [item.candidate.address],
              cc: [],
              bcc: [],
              replyTo: [],
              headers: item.headers,
              attachmentCount: 0,
            } satisfies MessageEnvelope,
            tags: request.tags ?? [],
            storageKey: item.storageKey,
            bodyBytes: bodyBytes(item.renderedHtml, item.renderedText),
            attachmentBytes: 0,
            bodyKey: item.encoded,
            testMode: caller.mode === "test",
            layout: Boolean(request.layout),
            requestId: currentRequestId() ?? null,
          })),
        )
        .returning();
    } catch (err) {
      await Promise.all(stored.map((item) => purgeBody(item.storageKey).catch(() => {})));
      log.error(`couldn't insert ${stored.length} messages for batch ${batchId}: ${safeErrorMessage(err)}`);
      skippedCount += stored.length;
      continue;
    }

    await db
      .insert(messageEvents)
      .values(rows.map((row) => ({ id: newId("event"), organizationId: caller.organizationId, messageId: row.id, status: "queued" as const })))
      .catch((err: unknown) => log.warn(`couldn't record queued events for batch ${batchId}: ${safeErrorMessage(err)}`));
    await Promise.all(rows.map((row) => publishMessageUpdate(caller.organizationId, { messageId: row.id, status: "queued" }).catch(() => {})));
    for (const row of rows) {
      createdMessageIds.push(row.id);
      created.push(row);
    }
  }

  const [batch] = await db
    .insert(batches)
    .values({
      id: batchId,
      organizationId: caller.organizationId,
      domainId: domain.id,
      apiKeyId: caller.apiKeyId,
      listId: request.list ?? null,
      fromAddress: from.address,
      subject: request.subject,
      tags: request.tags ?? [],
      recipientCount: createdMessageIds.length,
      skippedCount,
    })
    .returning();
  if (!batch) throw new ApiError("provider_unavailable", "The batch couldn't be recorded.");

  // One line for the batch, not one per recipient: the message ids are the batch's own rows.
  indexMessages(created, domain.name);
  log.info(`accepted batch ${batch.id} for organization ${caller.organizationId} (${createdMessageIds.length} messages, ${skippedCount} skipped)`);

  // One nudge wakes an idle worker for the whole batch — the subscriber ticks on any message,
  // not the specific id it was published with. See lib/messages/queue.ts.
  if (createdMessageIds[0]) await notifyQueued(createdMessageIds[0]).catch(() => {});

  return serializeBatch(batch, await statusCounts(batch.id));
}

export async function statusCounts(batchId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: messages.status, total: count() })
    .from(messages)
    .where(eq(messages.batchId, batchId))
    .groupBy(messages.status)
    .orderBy(messages.status);
  return Object.fromEntries(rows.map((row) => [row.status, row.total]));
}

export interface BatchCallerScope {
  organizationId: string;
  domainIds: string[];
}

export async function batchFor(caller: BatchCallerScope, id: string): Promise<BatchRow> {
  const [batch] = await db
    .select()
    .from(batches)
    .where(and(eq(batches.organizationId, caller.organizationId), eq(batches.id, id)))
    .limit(1);
  if (!batch) throw new ApiError("not_found", `No batch with id ${id}.`);
  if (!keyCanAccessDomain(caller, batch.domainId)) {
    throw new ApiError("key_not_scoped", `This key can't reach this batch.`);
  }
  return batch;
}
