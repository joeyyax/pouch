import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { inboundMessages, type InboundMessageRow } from "@/lib/db/schema";
import { selectShape, type Selection } from "@/lib/api/shape";
import { inboundShape } from "@/lib/schemas/inbound";
import { inboundResponse, type InboundResponse } from "./serialize";
import { keysetBefore } from "@/lib/db/keyset";
import { latestInboundDeliveries } from "@/lib/webhooks/deliveries";

/** An API key's or session's organization and domain scope. */
export interface InboundReadCaller {
  organizationId: string;
  domainIds: string[];
}

export interface InboundListFilters {
  domain?: string;
  /** The sent message these reply to. */
  outboundMessage?: string;
}

export interface InboundPage {
  data: InboundResponse[];
  next_cursor: string | null;
}

/** One page of rows, newest first, and the cursor past it. */
export async function selectInboundRows(
  caller: InboundReadCaller,
  limit: number,
  cursor?: string,
  filters: InboundListFilters = {},
): Promise<{ rows: InboundMessageRow[]; nextCursor: string | null }> {
  const after = cursor
    ? await db
        .select({ id: inboundMessages.id })
        .from(inboundMessages)
        .where(and(eq(inboundMessages.organizationId, caller.organizationId), eq(inboundMessages.id, cursor)))
        .limit(1)
    : [];
  const edge = after[0];

  const rows = await db
    .select()
    .from(inboundMessages)
    .where(
      and(
        eq(inboundMessages.organizationId, caller.organizationId),
        caller.domainIds.length > 0 ? inArray(inboundMessages.domainId, caller.domainIds) : undefined,
        filters.domain ? eq(inboundMessages.domainId, filters.domain) : undefined,
        filters.outboundMessage ? eq(inboundMessages.outboundMessageId, filters.outboundMessage) : undefined,
        edge ? keysetBefore({ table: inboundMessages, sort: inboundMessages.receivedAt, id: inboundMessages.id }, edge.id) : undefined,
      ),
    )
    .orderBy(desc(inboundMessages.receivedAt), desc(inboundMessages.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return { rows: page, nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
}

export async function listInboundMessages(
  caller: InboundReadCaller,
  limit: number,
  cursor?: string,
  filters: InboundListFilters = {},
  selection: Selection = selectShape(inboundShape),
): Promise<InboundPage> {
  const { rows, nextCursor } = await selectInboundRows(caller, limit, cursor, filters);
  const deliveries = selection.expands("delivery") ? await latestInboundDeliveries(caller.organizationId, rows) : null;
  return {
    data: await Promise.all(rows.map((row) => inboundResponse(row, selection, deliveries ? (deliveries[row.id] ?? null) : undefined))),
    next_cursor: nextCursor,
  };
}

export async function readInboundMessage(organizationId: string, id: string): Promise<InboundMessageRow | null> {
  const [row] = await db
    .select()
    .from(inboundMessages)
    .where(and(eq(inboundMessages.organizationId, organizationId), eq(inboundMessages.id, id)))
    .limit(1);
  return row ?? null;
}
