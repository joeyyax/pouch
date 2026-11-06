import { and, arrayContains, asc, desc, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { keysetAfter, keysetBefore } from "@/lib/db/keyset";
import { apiKeys, bulkFanoutRecipients, domains, messages, suppressions } from "@/lib/db/schema";
import type { MessageRow, OwnedMessageRow } from "@/lib/db/schema";
import { latestDomainStats, utcDay } from "@/lib/domains/daily-stats";
import { chooseFacts, type FactInput } from "@/lib/dashboard/message-facts";
import { normalizeAddress } from "@/lib/addresses";
import { ApiError } from "@/lib/api/errors";
import { project, selectShape } from "@/lib/api/shape";
import { loadBody } from "@/lib/messages/body";
import { findMessage } from "@/lib/messages/read";
import { resendRefusal } from "@/lib/messages/resend";
import { queueDepth } from "@/lib/messages/queue-depth";
import { dbNow } from "@/lib/db/clock";
import { domainFrames, renderSent } from "@/lib/messages/rendered";
import { assembleMessage, messageEventRows, messageResponse, type FullMessage } from "@/lib/messages/response";
import { listInboundMessages } from "@/lib/inbound/list";
import { readRecipients } from "@/lib/recipients";
import { recipientShape } from "@/lib/schemas/shapes";
import { inboundShape } from "@/lib/schemas/inbound";
import { messageReadShape } from "@/lib/schemas/message";
import { KEY_PLACEHOLDER, messageReadSnippets, readExample } from "@/lib/dashboard/curl";
import { retentionDaysFor } from "@/lib/organizations";
import { isStuckInQueue, LIST_LIMIT } from "@/lib/dashboard/views/messages";
import type { ApiExchange, MessageBodyView, MessageDetailData, MessageListItem } from "@/lib/dashboard/views/messages";
import type { QueueSummary } from "@/lib/dashboard/views/service";
import type { MessageFilters } from "@/lib/messages/filters";
import { fuzzyMatches } from "@/lib/search";
import { listWindowStart, messageListConditions } from "@/lib/dashboard/message-volume";

/** Replies the detail lists: one page of the API's, at its largest. */
const REPLY_LIMIT = 200;

/** The list's filters with the typo-tolerant index's matches for its search added. */
export async function withFuzzySearch(
  organizationId: string,
  filters: MessageFilters,
): Promise<{ filters: MessageFilters; searchDegraded: boolean }> {
  const term = filters.search?.trim();
  if (!term) return { filters, searchDegraded: false };
  const found = await fuzzyMatches("messages", { organizationId, term, since: listWindowStart(filters.since) });
  return { filters: { ...filters, fuzzyIds: found.ids }, searchDegraded: found.degraded };
}

/** Which of these addresses are suppressed, matched on the normalized form. */
async function suppressedAmong(organizationId: string, addresses: string[]): Promise<Set<string>> {
  const normalized = [...new Set(addresses.map(normalizeAddress))];
  if (normalized.length === 0) return new Set();
  const rows = await db
    .select({ address: suppressions.address })
    .from(suppressions)
    .where(and(eq(suppressions.organizationId, organizationId), inArray(suppressions.address, normalized)));
  return new Set(rows.map((row) => row.address));
}

/** Where a page of the list starts: older than `before`, or newer than `after`. Both name a message id. */
export interface MessageCursor {
  before?: string | undefined;
  after?: string | undefined;
}

export interface MessagePage {
  rows: MessageListItem[];
  /** How many messages under the same filters are newer than this page's first row. */
  offset: number;
  hasOlder: boolean;
}

const order = { table: messages, sort: messages.createdAt, id: messages.id };

async function selectMessages(
  organizationId: string,
  filters: MessageFilters,
  cursor: MessageCursor,
  limit: number,
): Promise<MessageListItem[]> {
  const newer = Boolean(cursor.after);
  const rows = await db
    .select({
      message: {
        id: messages.id,
        status: messages.status,
        subject: messages.subject,
        recipients: messages.recipients,
        apiKeyId: messages.apiKeyId,
        createdAt: messages.createdAt,
        testMode: messages.testMode,
        bodyWithheld: messages.bodyWithheld,
      },
      domainName: domains.name,
      keyName: apiKeys.name,
    })
    .from(messages)
    .innerJoin(domains, eq(domains.id, messages.domainId))
    .leftJoin(apiKeys, eq(apiKeys.id, messages.apiKeyId))
    .where(
      and(
        messageListConditions(organizationId, filters),
        cursor.after ? keysetAfter(order, cursor.after) : cursor.before ? keysetBefore(order, cursor.before) : undefined,
      ),
    )
    .orderBy(...(newer ? [asc(messages.createdAt), asc(messages.id)] : [desc(messages.createdAt), desc(messages.id)]))
    .limit(limit);
  if (newer) rows.reverse();

  // Every recipient, not just the first: a send to fifty addresses is suppressed if any of
  // them is, and a row that only checked the first would say the wrong thing.
  const suppressed = await suppressedAmong(
    organizationId,
    rows.flatMap((row) => row.message.recipients),
  );

  const now = new Date();
  return rows.map(({ message, domainName, keyName }) => {
    return {
      id: message.id,
      status: message.status,
      subject: message.subject,
      to: message.recipients[0] ?? "",
      recipientCount: message.recipients.length,
      domainName,
      keyId: message.apiKeyId,
      keyName,
      createdAt: message.createdAt,
      testMode: message.testMode,
      sensitive: typeof message.bodyWithheld === "string",
      suppressed: message.recipients.some((address) => suppressed.has(address)),
      stuck: isStuckInQueue(message.status, message.createdAt, now),
    };
  });
}

export async function listMessages(
  organizationId: string,
  filters: MessageFilters = {},
): Promise<MessageListItem[]> {
  return selectMessages(organizationId, filters, {}, LIST_LIMIT);
}

/**
 * One page of the list, keyset-paged on `(created_at, id)` so rows sharing a timestamp are
 * never skipped or repeated. A newer page short of a full one falls back to the newest page.
 */
export async function listMessagePage(
  organizationId: string,
  filters: MessageFilters = {},
  cursor: MessageCursor = {},
  limit = LIST_LIMIT,
): Promise<MessagePage> {
  if (cursor.after) {
    const rows = await selectMessages(organizationId, filters, { after: cursor.after }, limit + 1);
    if (rows.length <= limit) return listMessagePage(organizationId, filters, {}, limit);
    const page = rows.slice(1);
    return { rows: page, offset: await countNewer(organizationId, filters, page[0]?.id), hasOlder: true };
  }

  const rows = await selectMessages(organizationId, filters, { before: cursor.before }, limit + 1);
  const page = rows.slice(0, limit);
  return {
    rows: page,
    offset: cursor.before ? await countNewer(organizationId, filters, page[0]?.id ?? cursor.before) : 0,
    hasOlder: rows.length > limit,
  };
}

async function countNewer(organizationId: string, filters: MessageFilters, id: string | undefined): Promise<number> {
  if (!id) return 0;
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(domains, eq(domains.id, messages.domainId))
    .where(and(messageListConditions(organizationId, filters), keysetAfter(order, id)));
  return row?.total ?? 0;
}

/**
 * Distinct tags on messages in the list's own scope, so the filter only offers tags that
 * would actually narrow it. Bounded by `messages_organization_created_idx`, same as the
 * list itself — the GIN index added for tag lookups doesn't help here, since enumerating
 * distinct array elements isn't a containment query and can't use it.
 */
export async function listTags(
  organizationId: string,
  filters: Pick<MessageFilters, "domain" | "since"> = {},
): Promise<string[]> {
  const rows = await db.execute<{ tag: string }>(sql`
    select distinct tag
    from ${messages}
    ${filters.domain ? sql`inner join ${domains} on ${domains.id} = ${messages.domainId}` : sql``}, unnest(${messages.tags}) as tag
    where ${messages.organizationId} = ${organizationId}
      and ${messages.createdAt} >= ${listWindowStart(filters.since).toISOString()}
      ${filters.domain ? sql`and ${domains.name} = ${filters.domain}` : sql``}
    order by tag
  `);
  return rows.map((row) => row.tag);
}

/* ---------------------------------------------------------------- detail --- */

function headerBlock(message: MessageRow, domainName: string): string {
  const { envelope } = message;
  const from = envelope.fromName ? `${envelope.fromName} <${envelope.from}>` : envelope.from;
  const lines = [
    `Message-ID: <${message.id}@${domainName}>`,
    `Date: ${message.createdAt.toUTCString()}`,
    `From: ${from}`,
    `To: ${envelope.to.join(", ")}`,
  ];
  if (envelope.cc.length > 0) lines.push(`Cc: ${envelope.cc.join(", ")}`);
  if (envelope.bcc.length > 0) lines.push(`Bcc: ${envelope.bcc.join(", ")}`);
  if (envelope.replyTo.length > 0) lines.push(`Reply-To: ${envelope.replyTo.join(", ")}`);
  lines.push(`Subject: ${message.subject}`);
  for (const [name, value] of Object.entries(envelope.headers)) lines.push(`${name}: ${value}`);
  return lines.join("\n");
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Live messages withheld for the same reason to this message's only recipient, in the 7 days and
 * the 24 hours up to it. An empty reason counts every sensitive message. Rides `messages_withheld_idx`.
 */
async function sensitiveCounts(message: OwnedMessageRow): Promise<FactInput["sensitive"]> {
  const reason = message.bodyWithheld;
  const [address] = message.recipients;
  if (typeof reason !== "string" || message.recipients.length !== 1 || !address || message.testMode) return null;
  const dayStart = new Date(message.createdAt.getTime() - DAY_MS);
  const [row] = await db
    .select({
      week: sql<number>`count(*)::int`,
      day: sql<number>`count(*) filter (where ${messages.createdAt} > ${dayStart.toISOString()}::timestamptz)::int`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, message.organizationId),
        isNotNull(messages.bodyWithheld),
        reason ? eq(messages.bodyWithheld, reason) : undefined,
        gt(messages.createdAt, new Date(message.createdAt.getTime() - 7 * DAY_MS)),
        lte(messages.createdAt, message.createdAt),
        eq(messages.testMode, false),
        arrayContains(messages.recipients, [address]),
      ),
    );
  return { reason, week: row?.week ?? 0, day: row?.day ?? 0 };
}

/** What the fun facts need beyond the row and the recipient: the body's fan-out, the domain's latest stats row and the sensitive counts. */
async function factSources(message: OwnedMessageRow): Promise<Pick<FactInput, "fanout" | "stats" | "sensitive">> {
  const day = utcDay(message.createdAt);
  const [fanout, stats, sensitive] = await Promise.all([
    message.apiKeyId && message.bodyHash && !message.testMode
      ? db
          .select({ recipients: sql<number>`count(*)::int` })
          .from(bulkFanoutRecipients)
          .where(
            and(
              eq(bulkFanoutRecipients.apiKeyId, message.apiKeyId),
              eq(bulkFanoutRecipients.bodyHash, message.bodyHash),
              eq(bulkFanoutRecipients.day, day),
              eq(bulkFanoutRecipients.organizationId, message.organizationId),
            ),
          )
          .then(([row]) => ({ recipients: row?.recipients ?? 0, day }))
      : null,
    latestDomainStats(message.organizationId, message.domainId),
    sensitiveCounts(message),
  ]);
  return { fanout, stats, sensitive };
}

/** The message the API would return for this id in the organization, or null. Never reaches outside it. */
async function organizationMessage(organizationId: string, id: string): Promise<OwnedMessageRow | null> {
  try {
    return await findMessage({ organizationId, domainIds: [] }, id);
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return null;
    throw error;
  }
}

/** The names the detail shows beside the ids. */
async function sendNames(message: OwnedMessageRow): Promise<{ domainName: string; keyName: string | null; keyRevoked: boolean }> {
  const [[domain], [key]] = await Promise.all([
    db.select({ name: domains.name }).from(domains).where(eq(domains.id, message.domainId)).limit(1),
    message.apiKeyId
      ? db
          .select({ name: apiKeys.name, revokedAt: apiKeys.revokedAt })
          .from(apiKeys)
          .where(and(eq(apiKeys.organizationId, message.organizationId), eq(apiKeys.id, message.apiKeyId)))
          .limit(1)
      : [],
  ]);
  return { domainName: domain?.name ?? "", keyName: key?.name ?? null, keyRevoked: Boolean(key?.revokedAt) };
}

/** One message in the operator's organization, or null. The body and the `include=body` response load when their tabs open. */
export async function readMessage(organizationId: string, id: string): Promise<MessageDetailData | null> {
  const message = await organizationMessage(organizationId, id);
  if (!message) return null;

  const [{ domainName, keyName, keyRevoked }, eventRows] = await Promise.all([
    sendNames(message),
    messageEventRows(organizationId, [message.id]).then((rows) => rows.get(message.id) ?? []),
  ]);
  const events = [...eventRows].reverse();

  // The envelope keeps to, cc and bcc apart; messages.recipients is the flattened match key.
  const { envelope } = message;
  const addressed: [address: string, field: "to" | "cc" | "bcc"][] = [
    ...envelope.to.map((address) => [address, "to"] as [string, "to"]),
    ...envelope.cc.map((address) => [address, "cc"] as [string, "cc"]),
    ...envelope.bcc.map((address) => [address, "bcc"] as [string, "bcc"]),
  ];

  // One number can't stand for several addresses, so counts are only read when there's one.
  const only = addressed.length === 1 ? addressed[0]?.[0] : undefined;
  const onFile = await readRecipients(
    { organizationId, domainIds: [] },
    addressed.map(([address]) => address),
    selectShape(recipientShape, { fields: only ? ["suppression", "messages", "first_seen_at", "bounce_count", "complaint_count"] : ["suppression"] }),
  );
  const recipients = addressed.map(([address, field]) => {
    const suppression = onFile.get(normalizeAddress(address))?.suppression;
    return { address, field, suppressed: Boolean(suppression), suppressedAt: suppression ? new Date(suppression.created_at) : null };
  });
  const single = only ? onFile.get(normalizeAddress(only)) : undefined;
  const messageCount = only ? (single?.messages.total ?? 0) : null;
  const history = single?.first_seen_at
    ? { firstSeenAt: new Date(single.first_seen_at), bounceCount: single.bounce_count, complaintCount: single.complaint_count }
    : null;

  const replyPage = await listInboundMessages(
    { organizationId, domainIds: [] },
    REPLY_LIMIT,
    undefined,
    { outboundMessage: message.id },
    selectShape(inboundShape, { fields: ["from", "subject", "received_at"] }),
  );
  const replies = replyPage.data.map((reply) => ({
    id: reply.id!,
    from: reply.from!,
    subject: reply.subject!,
    receivedAt: new Date(reply.received_at!),
  }));

  const sources = await factSources(message);
  const facts = chooseFacts({
    now: new Date(),
    domainName,
    testMode: message.testMode,
    createdAt: message.createdAt,
    sentAt: message.sentAt,
    deliveredAt: message.deliveredAt,
    attempts: message.attempts,
    events,
    messageCount,
    history,
    ...sources,
  });

  const [full, retentionDays] = await Promise.all([
    assembleMessage(message, { events: true, stall: true, resends: true }, new Date(), { events: eventRows }),
    retentionDaysFor(organizationId),
  ]);

  return {
    id: message.id,
    status: message.status,
    subject: message.subject,
    fromAddress: message.fromAddress,
    fromName: message.envelope.fromName,
    envelope: message.envelope,
    tags: message.tags,
    testMode: message.testMode,
    warnings: message.warnings,
    layout: message.layout,
    providerMessageId: message.providerMessageId,
    failureReason: message.failureReason,
    attempts: message.attempts,
    createdAt: message.createdAt,
    sentAt: message.sentAt,
    nextAttemptAt: nextAttemptShown(full),
    stuck: isStuckInQueue(message.status, message.createdAt),
    abandonedAt: full.abandoned_at ? new Date(full.abandoned_at) : null,
    size: full.size,
    domainId: message.domainId,
    domainName,
    keyId: message.apiKeyId,
    keyName,
    keyRevoked,
    events: events.map((event) => ({
      id: event.id,
      kind: event.kind,
      status: event.status,
      reason: event.reason,
      detail: event.detail,
      occurredAt: event.occurredAt,
    })),
    recipients,
    messageCount,
    headers: headerBlock(message, domainName),
    api: {
      plain: { requests: messageReadSnippets(KEY_PLACEHOLDER, message.id), response: JSON.stringify(project(full, selectShape(messageReadShape)), null, 2) },
      withBodyRequests: messageReadSnippets(KEY_PLACEHOLDER, message.id, true),
    },
    stall: full.stall ?? null,
    replies,
    facts,
    resentFrom: message.resentFrom,
    resends: (full.resends ?? []).map((copy) => ({ id: copy.id, status: copy.status, createdAt: new Date(copy.created_at) })),
    resendBlocked: resendRefusal(message, retentionDays)?.message ?? null,
  };
}

/** A retry still ahead. A due time is now, and a held message's time is only the next check of its hold. */
function nextAttemptShown(full: FullMessage, now = new Date()): Date | null {
  const at = full.next_attempt_at ? new Date(full.next_attempt_at) : null;
  return at && at > now && !full.stall ? at : null;
}

const messagePath = (id: string) => `/v1/emails/${id}`;

function exchange(request: string, response: object): ApiExchange {
  return { request: readExample(KEY_PLACEHOLDER, request), response: JSON.stringify(response, null, 2) };
}

/** The body tabs: the stored body, framed the way the worker frames it. Null when the message isn't the organization's. */
export async function readMessageBody(organizationId: string, id: string): Promise<MessageBodyView | null> {
  const message = await organizationMessage(organizationId, id);
  if (!message) return null;
  const [body, frames] = await Promise.all([
    retentionDaysFor(organizationId).then((days) => loadBody(message, days)),
    domainFrames(organizationId, [message.domainId]),
  ]);
  const rendered = renderSent(message, body, frames.get(message.domainId));
  return {
    body: body.state === "available" && rendered ? { ...body, html: rendered.html } : body,
    framed: rendered?.framed ?? false,
    frameChanged: rendered?.frame_changed ?? null,
  };
}

/** `GET /v1/emails/:id?include=body` as the API answers it, download links and all. */
export async function readMessageWithBody(organizationId: string, id: string): Promise<ApiExchange | null> {
  const message = await organizationMessage(organizationId, id);
  if (!message) return null;
  const response = await messageResponse(message, selectShape(messageReadShape, { include: ["body"] }));
  return exchange(`${messagePath(id)}?include=body`, response);
}

/** Queue depth and the oldest thing in it, for the service card. */
export async function queueSummary(organizationId: string): Promise<QueueSummary> {
  const queue = await queueDepth({ organizationId, domainIds: [], mode: "all" }, await dbNow());
  return { depth: queue.queued, oldestQueuedAt: queue.oldest_queued_at };
}