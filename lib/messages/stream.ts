import { and, eq, gte, inArray, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageEvents, messages, isTransition } from "@/lib/db/schema";
import type { MessageRow, MessageStatus, MessageTransitionRow } from "@/lib/db/schema";
import { serializeMessage, type SerializedMessage } from "./serialize";
import type { KeyMode } from "@/lib/api/keys";
import { EVENTS_OLDEST_FIRST, eventsAfter } from "./event-order";

/**
 * The type every lifecycle transition carries on a stream frame. Mirrors the three webhook
 * event names for the statuses webhooks already send (`email.delivered`, `email.bounced`,
 * `email.complained`, see lib/webhooks/dispatch.ts) and extends the same `email.<status>` shape
 * to the rest of the lifecycle, so a caller watching a full send doesn't need a second
 * vocabulary for the transitions webhooks don't cover.
 */
export const STREAM_EVENT_TYPE_FOR: Record<MessageStatus, string> = {
  queued: "email.queued",
  sent: "email.sent",
  delivered: "email.delivered",
  deferred: "email.deferred",
  bounced: "email.bounced",
  complained: "email.complained",
  failed: "email.failed",
};

export const STREAM_EVENT_TYPES = Object.values(STREAM_EVENT_TYPE_FOR);

const STATUS_FOR_STREAM_EVENT_TYPE: Partial<Record<string, MessageStatus>> = Object.fromEntries(
  Object.entries(STREAM_EVENT_TYPE_FOR).map(([status, type]) => [type, status as MessageStatus]),
);

export interface StreamFrame {
  id: string;
  type: string;
  created_at: string;
  data: SerializedMessage;
}

/** The same shape a webhook posts, so a caller that parses one parses the other with no second parser. */
export function buildStreamFrame(event: MessageTransitionRow, message: MessageRow): StreamFrame {
  return {
    id: event.id,
    type: STREAM_EVENT_TYPE_FOR[event.status],
    created_at: event.occurredAt.toISOString(),
    data: serializeMessage(message),
  };
}

export interface StreamCursor {
  occurredAt: Date;
  id: string;
}

/** An API key's organization and domain scope — everything a stream query needs about the caller. */
export interface StreamCaller {
  organizationId: string;
  domainIds: string[];
  /** A test key streams only test mail. */
  mode?: KeyMode;
}

export interface StreamEvent {
  event: MessageTransitionRow;
  message: MessageRow;
}

/** Largest catch-up a reconnect pulls in one query. Bounds what a stale `Last-Event-ID` can replay. */
export const MAX_STREAM_REPLAY = 500;

/**
 * Lifecycle transitions a key can see, oldest first. Scoped to the key's domains exactly like
 * every other read in this codebase (see lib/messages/list.ts) — this is the security boundary
 * `GET /v1/events` relies on, since the Redis channel behind it is per-organization, not
 * per-domain. Both stream routes, and the tests that prove domain scoping holds, go through
 * this one function rather than each building their own query.
 */
// A cursor with no id is a start time, from a stream that opened with nothing to resume.
function afterCursor(cursor: StreamCursor): SQL {
  if (!cursor.id) return gte(messageEvents.occurredAt, cursor.occurredAt);
  return eventsAfter(cursor.id);
}

export async function streamEventsForKey(
  key: StreamCaller,
  options: { after?: StreamCursor; messageId?: string; type?: string; limit?: number } = {},
): Promise<StreamEvent[]> {
  let status: MessageStatus | undefined;
  if (options.type) {
    status = STATUS_FOR_STREAM_EVENT_TYPE[options.type];
    if (!status) return [];
  }

  const rows = await db
    .select({ event: messageEvents, message: messages })
    .from(messageEvents)
    .innerJoin(messages, eq(messages.id, messageEvents.messageId))
    .where(
      and(
        eq(messageEvents.organizationId, key.organizationId),
        eq(messageEvents.kind, "transition"),
        key.domainIds.length > 0 ? inArray(messages.domainId, key.domainIds) : undefined,
        key.mode === "test" ? eq(messages.testMode, true) : undefined,
        options.messageId ? eq(messages.id, options.messageId) : undefined,
        status ? eq(messageEvents.status, status) : undefined,
        options.after ? afterCursor(options.after) : undefined,
      ),
    )
    .orderBy(...EVENTS_OLDEST_FIRST)
    .limit(options.limit ?? MAX_STREAM_REPLAY);

  return rows.filter((row): row is StreamEvent => isTransition(row.event));
}

/**
 * Resolves a `Last-Event-ID` header to the cursor it names, scoped to the key's organization and
 * domains. `null` when it doesn't resolve — an unknown or out-of-scope id is treated as no
 * cursor, the same way a foreign pagination cursor is ignored elsewhere in this API, rather than
 * as an error a reconnecting client has to handle specially.
 */
export async function eventCursorFor(key: StreamCaller, lastEventId: string | null): Promise<StreamCursor | null> {
  if (!lastEventId) return null;
  const [row] = await db
    .select({ event: messageEvents })
    .from(messageEvents)
    .innerJoin(messages, eq(messages.id, messageEvents.messageId))
    .where(
      and(
        eq(messageEvents.organizationId, key.organizationId),
        eq(messageEvents.id, lastEventId),
        key.domainIds.length > 0 ? inArray(messages.domainId, key.domainIds) : undefined,
        key.mode === "test" ? eq(messages.testMode, true) : undefined,
      ),
    )
    .limit(1);
  return row ? { occurredAt: row.event.occurredAt, id: row.event.id } : null;
}
