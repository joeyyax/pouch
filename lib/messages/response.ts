import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageEvents, type MessageEventRow, type MessageRow } from "@/lib/db/schema";
import { project, type Selection } from "@/lib/api/shape";
import { retentionDaysFor } from "@/lib/organizations";
import { bodyUnavailable, loadBody, serializeBody, type MessageBody, type SerializedBody, type SerializedBodyUnavailable } from "./body";
import { baseColumns, serializeMessage, type SerializedMessage } from "./serialize";
import { messageHold } from "./stall";
import { EVENTS_OLDEST_FIRST } from "./event-order";
import { domainFrames, renderSent, type SerializedRendered } from "./rendered";
import { resendCopies, type ResendCopy } from "./resend";

/** A message with every expansion the API has. A response is a projection of this. */
export interface FullMessage extends SerializedMessage {
  body?: SerializedBody | null;
  body_unavailable?: SerializedBodyUnavailable | null;
  rendered?: SerializedRendered | null;
  resends?: ResendCopy[];
}

export type MessageResponse = Partial<FullMessage>;

/** What to load beyond the row. */
export interface MessageParts {
  events?: boolean;
  occurrences?: boolean;
  stall?: boolean;
  body?: boolean;
  rendered?: boolean;
  resends?: boolean;
  /** Base keys to build. Every one when unset. */
  keys?: ReadonlySet<string>;
}

/** Reads already made for one message, so assembling it doesn't repeat them. */
export interface Preloaded {
  /** Every event row, oldest first. */
  events?: MessageEventRow[];
  body?: MessageBody;
}

export function partsFor(selection: Selection): MessageParts {
  return {
    events: selection.expands("events"),
    occurrences: selection.expands("occurrences"),
    stall: selection.expands("stall"),
    body: selection.expands("body"),
    rendered: selection.expands("rendered"),
    resends: selection.expands("resends"),
    keys: selection.keys,
  };
}

type Column = keyof MessageRow;

const BODY_COLUMNS: Column[] = ["id", "createdAt", "bodyPurgedAt", "bodyWithheld", "bodyKey", "storageKey"];

/** The row columns a selection reads, so a list can select only those. */
export function columnsFor(selection: Selection): Column[] {
  const parts = partsFor(selection);
  const columns = baseColumns(selection.keys);
  for (const column of ["id", "organizationId"] as Column[]) columns.add(column);
  if (parts.stall) for (const column of ["status", "domainId"] as Column[]) columns.add(column);
  if (parts.body || parts.rendered) for (const column of BODY_COLUMNS) columns.add(column);
  if (parts.rendered) for (const column of ["layout", "layoutOverrides", "bodyHash", "domainId"] as Column[]) columns.add(column);
  return [...columns];
}

/** A message's events, every kind, oldest first: the one read the API, the timeline and the facts share. */
export async function messageEventRows(organizationId: string, messageIds: string[]): Promise<Map<string, MessageEventRow[]>> {
  const byMessage = new Map<string, MessageEventRow[]>(messageIds.map((id) => [id, []]));
  if (messageIds.length === 0) return byMessage;
  const rows = await db
    .select()
    .from(messageEvents)
    .where(and(eq(messageEvents.organizationId, organizationId), inArray(messageEvents.messageId, messageIds)))
    .orderBy(...EVENTS_OLDEST_FIRST);
  for (const row of rows) byMessage.get(row.messageId)?.push(row);
  return byMessage;
}

/**
 * Serializes one organization's messages with the parts asked for, in one events query, one
 * retention lookup and one domain read. `preloaded` applies to a single message.
 */
export async function assembleMessages(
  organizationId: string,
  rows: MessageRow[],
  parts: MessageParts,
  now = new Date(),
  preloaded: Preloaded = {},
): Promise<FullMessage[]> {
  const ids = rows.map((row) => row.id);
  const wantsEvents = parts.events || parts.occurrences;
  const events = !wantsEvents
    ? null
    : preloaded.events && rows.length === 1
      ? new Map([[ids[0]!, preloaded.events]])
      : await messageEventRows(organizationId, ids);
  const wantsBody = parts.body || parts.rendered;
  const retentionDays = wantsBody && !preloaded.body && rows.length > 0 ? await retentionDaysFor(organizationId) : null;
  const frames = parts.rendered ? await domainFrames(organizationId, rows.map((row) => row.domainId)) : null;
  const copies = parts.resends ? await resendCopies(organizationId, ids) : null;

  const assembled = await Promise.all(
    rows.map(async (row) => {
      const hold = parts.stall ? await messageHold(row) : undefined;
      const serialized: FullMessage = serializeMessage(row, {
        events: events?.get(row.id),
        occurrences: parts.occurrences,
        domainStall: hold?.domainStall,
        organizationStall: hold?.organizationStall,
        keys: parts.keys,
      });
      if (!parts.events) delete serialized.events;
      if (!wantsBody) return serialized;
      const body = preloaded.body ?? (await loadBody(row, retentionDays!, now));
      return {
        ...serialized,
        ...(parts.body ? { body: serializeBody(row.id, body, now).body } : {}),
        ...(parts.rendered ? { rendered: renderSent(row, body, frames?.get(row.domainId)) } : {}),
        body_unavailable: bodyUnavailable(body),
      };
    }),
  );
  if (!copies) return assembled;
  return assembled.map((message) => ({ ...message, resends: copies.get(message.id!) ?? [] }));
}

export async function assembleMessage(message: MessageRow, parts: MessageParts, now = new Date(), preloaded: Preloaded = {}): Promise<FullMessage> {
  if (message.organizationId === null) throw new Error(`Message ${message.id} is system mail, which no organization reads.`);
  const [full] = await assembleMessages(message.organizationId, [message], parts, now, preloaded);
  return full!;
}

/** One message as the API returns it under `selection`. */
export async function messageResponse(message: MessageRow, selection: Selection, preloaded: Preloaded = {}): Promise<MessageResponse> {
  return project(await assembleMessage(message, partsFor(selection), new Date(), preloaded), selection);
}
