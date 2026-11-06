/** The shapes the inbound dashboard screens render, and the query helpers behind them. */
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, inboundMessages, messages } from "@/lib/db/schema";
import type { MessageStatus } from "@/lib/db/schema";
import { daysIn, metricsRange, type MetricsWindowDays } from "@/lib/metrics/window";
import { ApiError } from "@/lib/api/errors";
import { selectShape } from "@/lib/api/shape";
import { statsShape } from "@/lib/schemas/stats";
import { bucketStartsOf, readStats, type StatsResponse } from "@/lib/stats";
import { foldTotals, openEnd } from "@/lib/dashboard/local-buckets";
import type { InboundDay, InboundDelivery } from "@/lib/dashboard/views/inbound";
import { readInboundMessage, selectInboundRows } from "@/lib/inbound/list";
import { latestInboundDeliveries as readLatestInboundDeliveries } from "@/lib/webhooks/deliveries";
import { inboundLinks, serializeInboundMessage, serializeInboundWithLinks, type SerializedInboundMessage } from "@/lib/inbound/serialize";

const INBOUND_SELECTION = selectShape(statsShape, { fields: ["inbound"] });

export interface DomainOption {
  id: string;
  name: string;
}

/** The outbound send an inbound reply is matched to — the other end of the conversation. */
export interface RepliedToMessage {
  id: string;
  subject: string;
  status: MessageStatus;
  createdAt: Date;
}

export interface InboundDetailView extends SerializedInboundMessage {
  /** Null when in_reply_to didn't match anything — the common case. */
  repliedTo: RepliedToMessage | null;
  /** The newest webhook delivery. Null when none was enqueued. */
  delivery: InboundDelivery | null;
}

export async function listInboundDomainOptions(organizationId: string): Promise<DomainOption[]> {
  const rows = await db
    .select({ id: domains.id, name: domains.name })
    .from(domains)
    .where(eq(domains.organizationId, organizationId))
    .orderBy(domains.name);
  return rows;
}

/** Domains worth filtering by: inbound on, or mail still held from when it was. */
export async function listInboundFilterDomains(organizationId: string): Promise<DomainOption[]> {
  const held = db
    .selectDistinct({ domainId: inboundMessages.domainId })
    .from(inboundMessages)
    .where(eq(inboundMessages.organizationId, organizationId));
  return db
    .select({ id: domains.id, name: domains.name })
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), or(eq(domains.inboundEnabled, true), inArray(domains.id, held))))
    .orderBy(domains.name);
}

/** Mail received per day in `zone`, oldest first, zero-filled. */
export async function inboundByDay(
  organizationId: string,
  zone: string,
  options: { domainId?: string; days?: MetricsWindowDays; now?: Date } = {},
): Promise<InboundDay[]> {
  const range = metricsRange(options.days ?? 30, options.now);
  const stats = (await readStats(
    { organizationId, domainIds: [] },
    { since: range.since, until: await openEnd(range.until), bucket: "hour", domain: options.domainId },
    INBOUND_SELECTION,
    range.until,
  ).catch((error: unknown) => {
    // A domain filter naming nothing here matches nothing.
    if (error instanceof ApiError && error.code === "not_found") return null;
    throw error;
  })) as Pick<StatsResponse, "inbound" | "window"> | null;
  const byDay = stats ? foldTotals(bucketStartsOf(stats.window), stats.inbound.buckets, zone, "day") : new Map<string, number>();
  return daysIn(range, zone).map((date) => ({ date, received: byDay.get(date.toISOString().slice(0, 10)) ?? 0 }));
}

/** The newest webhook delivery for each message, keyed by message id, as `include=delivery` reads it. A message with none is absent. */
export async function latestInboundDeliveries(
  organizationId: string,
  received: { id: string; receivedAt: Date }[],
): Promise<Record<string, InboundDelivery>> {
  const deliveries = await readLatestInboundDeliveries(organizationId, received);
  return Object.fromEntries(
    Object.entries(deliveries).map(([id, delivery]) => [
      id,
      { status: delivery.status, lastStatusCode: delivery.last_status_code, lastError: delivery.last_error, attempts: delivery.attempt_count },
    ]),
  );
}

export async function listInboundForOrg(
  organizationId: string,
  limit: number,
  cursor?: string,
  domainId?: string,
): Promise<{ data: SerializedInboundMessage[]; next_cursor: string | null }> {
  const { rows, nextCursor } = await selectInboundRows({ organizationId, domainIds: [] }, limit, cursor, { domain: domainId });
  // The list shows no body, so storage isn't read.
  return { data: rows.map((row) => serializeInboundMessage(row, { text: null, html: null }, inboundLinks(row))), next_cursor: nextCursor };
}

export async function readInboundForOrg(organizationId: string, id: string): Promise<InboundDetailView | null> {
  const row = await readInboundMessage(organizationId, id);
  if (!row) return null;

  let repliedTo: RepliedToMessage | null = null;
  if (row.outboundMessageId) {
    // Scoped by organization on both sides — a match can never point across that boundary, but
    // the read doesn't take that on faith.
    const [sent] = await db
      .select({ id: messages.id, subject: messages.subject, status: messages.status, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.organizationId, organizationId), eq(messages.id, row.outboundMessageId)))
      .limit(1);
    repliedTo = sent ?? null;
  }

  const deliveries = await latestInboundDeliveries(organizationId, [{ id: row.id, receivedAt: row.receivedAt }]);
  return { ...(await serializeInboundWithLinks(row)), repliedTo, delivery: deliveries[row.id] ?? null };
}
