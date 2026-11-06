import { and, arrayContains, desc, eq, gte, inArray, isNotNull, isNull, lte, not } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, type MessageRow, type MessageStatus } from "@/lib/db/schema";
import { project, selectShape, type Selection } from "@/lib/api/shape";
import { messageListShape } from "@/lib/schemas/message";
import { assembleMessages, columnsFor, partsFor, type MessageResponse } from "./response";
import { heldCondition } from "./held";
import { bounceReasonCondition } from "./reason";
import { keysetBefore } from "@/lib/db/keyset";
import { normalizeAddress } from "@/lib/addresses";
import type { KeyMode } from "@/lib/api/keys";

/** An API key's organization and domain scope — all a list query needs to know about the caller. */
export interface MessageCaller {
  organizationId: string;
  domainIds: string[];
  /** A test key lists only test mail. */
  mode?: KeyMode;
}

export interface MessageFilters {
  /** Any of these. */
  status?: MessageStatus[];
  domain?: string;
  /** Key id. Narrows within the caller's own scope; never widens it. */
  key?: string;
  /** Batch id. */
  batch?: string;
  /** Queued and held by a stall or a suspension, or everything else. */
  held?: boolean;
  /** Withheld from every read, or not. */
  sensitive?: boolean;
  tag?: string;
  to?: string;
  /** A bounce or complaint reason, matched exactly. */
  reason?: string;
  since?: Date;
  until?: Date;
}

export interface MessagePage {
  data: MessageResponse[];
  next_cursor: string | null;
}

export async function listMessages(
  key: MessageCaller,
  limit: number,
  cursor?: string,
  filters: MessageFilters = {},
  selection: Selection = selectShape(messageListShape),
): Promise<MessagePage> {
  // Scoped like every other read here: a foreign id must not become a pagination anchor.
  const after = cursor
    ? await db
        .select({ createdAt: messages.createdAt, id: messages.id })
        .from(messages)
        .where(and(eq(messages.organizationId, key.organizationId), eq(messages.id, cursor)))
        .limit(1)
    : [];
  const edge = after[0];

  // A partial row: the assembler builds only the keys the selection names.
  const columns = Object.fromEntries(columnsFor(selection).map((column) => [column, messages[column]]));
  const rows = (await db
    .select(columns)
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, key.organizationId),
        key.domainIds.length > 0 ? inArray(messages.domainId, key.domainIds) : undefined,
        key.mode === "test" ? eq(messages.testMode, true) : undefined,
        filters.status?.length ? inArray(messages.status, filters.status) : undefined,
        filters.domain ? eq(messages.domainId, filters.domain) : undefined,
        filters.key ? eq(messages.apiKeyId, filters.key) : undefined,
        filters.batch ? eq(messages.batchId, filters.batch) : undefined,
        filters.held === undefined ? undefined : filters.held ? heldCondition() : not(heldCondition()),
        filters.sensitive === undefined ? undefined : filters.sensitive ? isNotNull(messages.bodyWithheld) : isNull(messages.bodyWithheld),
        filters.tag ? arrayContains(messages.tags, [filters.tag]) : undefined,
        filters.to ? arrayContains(messages.recipients, [normalizeAddress(filters.to)]) : undefined,
        filters.reason ? bounceReasonCondition(filters.reason) : undefined,
        filters.since ? gte(messages.createdAt, filters.since) : undefined,
        filters.until ? lte(messages.createdAt, filters.until) : undefined,
        edge ? keysetBefore({ table: messages, sort: messages.createdAt, id: messages.id }, edge.id) : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1)) as unknown as MessageRow[];

  const page = rows.slice(0, limit);
  const full = await assembleMessages(key.organizationId, page, partsFor(selection));
  return {
    data: full.map((message) => project(message, selection)),
    next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}
