import { and, arrayContains, desc, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { db } from "@/lib/db";
import { keysetAfter, keysetBefore } from "@/lib/db/keyset";
import { inboundMessages } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { acquireStreamSlot, maxConcurrentStreams, type StreamSlot } from "@/lib/api/rate-limit";
import type { InboundPage } from "@/lib/inbound/list";
import { inboundResponse } from "@/lib/inbound/serialize";
import { selectShape } from "@/lib/api/shape";
import { inboundShape } from "@/lib/schemas/inbound";
import { logger } from "@/lib/logger";
import { redis, redisChannel } from "@/lib/redis";
import type { ListAddressMessagesRequest } from "@/lib/schemas/address";
import { addressInScope, type AddressCaller } from "./manage";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("addresses:inbox");

/** How often a wait re-reads with live updates on, in case a notice was lost. */
const BACKSTOP_MS = 5_000;
/** How often a wait re-reads when Redis is off. */
const POLL_MS = 1_000;
const SUBSCRIBE_TIMEOUT_MS = 3_000;

/** One channel per organization, so a subscriber only ever hears about its own addresses. */
export function addressMailChannel(organizationId: string): string {
  return redisChannel(`addresses:mail:${organizationId}`);
}

/** Tells waiting reads that mail reached these addresses. Never throws: the mail is stored either way. */
export async function publishAddressMail(organizationId: string, addressIds: string[]): Promise<void> {
  const client = redis();
  if (!client || addressIds.length === 0) return;
  try {
    await client.publish(addressMailChannel(organizationId), JSON.stringify({ addressIds }));
  } catch (err) {
    log.warn(`publish failed: ${safeErrorMessage(err)}`);
  }
}

const order = { table: inboundMessages, sort: inboundMessages.receivedAt, id: inboundMessages.id };

async function assertMessageInOrganization(organizationId: string, id: string, field: string): Promise<void> {
  const [found] = await db
    .select({ id: inboundMessages.id })
    .from(inboundMessages)
    .where(and(eq(inboundMessages.organizationId, organizationId), eq(inboundMessages.id, id)))
    .limit(1);
  if (!found) throw new ApiError("not_found", `No inbound message with id ${id}.`, { field });
}

async function readPage(organizationId: string, addressId: string, query: ListAddressMessagesRequest): Promise<InboundPage> {
  const selection = selectShape(inboundShape, { include: query.include, fields: query.fields });
  const rows = await db
    .select()
    .from(inboundMessages)
    .where(
      and(
        eq(inboundMessages.organizationId, organizationId),
        arrayContains(inboundMessages.addressIds, [addressId]),
        query.thread ? eq(inboundMessages.threadId, query.thread) : undefined,
        query.after ? keysetAfter(order, query.after) : undefined,
        query.cursor ? keysetBefore(order, query.cursor) : undefined,
      ),
    )
    .orderBy(desc(inboundMessages.receivedAt), desc(inboundMessages.id))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  return {
    data: await Promise.all(page.map((row) => inboundResponse(row, selection))),
    next_cursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
  };
}

async function withTimeout(work: Promise<unknown>, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), SUBSCRIBE_TIMEOUT_MS);
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A subscriber that calls `onMail` when this address receives, or null when Redis is off or unreachable. */
async function subscribe(organizationId: string, addressId: string, onMail: () => void): Promise<Redis | null> {
  const client = redis()?.duplicate({ lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  if (!client) return null;
  client.on("error", (err) => log.warn(`subscriber error: ${safeErrorMessage(err)}`));
  try {
    await withTimeout(client.connect(), "connect");
    await withTimeout(client.subscribe(addressMailChannel(organizationId)), "subscribe");
  } catch (err) {
    log.warn(`live updates unavailable: ${safeErrorMessage(err)}`);
    client.disconnect();
    return null;
  }
  client.on("message", (_channel, payload) => {
    try {
      if ((JSON.parse(payload) as { addressIds?: string[] }).addressIds?.includes(addressId)) onMail();
    } catch {
      // A malformed notice only costs the wait its early wake-up.
    }
  });
  return client;
}

/**
 * Re-reads until a message matches or `seconds` pass. Woken by a Redis notice from ingest, with a
 * periodic re-read behind it. Holds one of the key's stream slots while it waits.
 */
async function waitForPage(
  caller: AddressCaller,
  addressId: string,
  query: ListAddressMessagesRequest,
  signal: AbortSignal | undefined,
): Promise<InboundPage> {
  const deadline = Date.now() + query.wait * 1000;
  let slot: StreamSlot | undefined;
  if (caller.apiKeyId) {
    const outcome = await acquireStreamSlot(caller.apiKeyId, maxConcurrentStreams());
    if (!outcome.ok && outcome.reason === "limit") {
      throw new ApiError("stream_limit_exceeded", "Too many streams or waits open for this key. Close one and try again.");
    }
    if (outcome.ok) slot = outcome.slot;
  }

  let wake: (() => void) | null = null;
  let woken = false;
  const subscriber = await subscribe(caller.organizationId, addressId, () => {
    woken = true;
    wake?.();
  });
  const interval = subscriber ? BACKSTOP_MS : POLL_MS;

  const nap = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      wake = done;
      signal?.addEventListener("abort", done, { once: true });
    });

  try {
    for (;;) {
      woken = false;
      const page = await readPage(caller.organizationId, addressId, query);
      const remaining = deadline - Date.now();
      if (page.data.length > 0 || remaining <= 0 || signal?.aborted) return page;
      if (!woken) await nap(Math.min(remaining, interval));
    }
  } finally {
    void slot?.release();
    if (subscriber) void subscriber.quit().catch(() => subscriber.disconnect());
  }
}

/** Mail delivered to one address, newest first. With `wait`, holds until a message matches or the time runs out. */
export async function listAddressMessages(
  caller: AddressCaller,
  id: string,
  query: ListAddressMessagesRequest,
  signal?: AbortSignal,
): Promise<InboundPage> {
  const { row } = await addressInScope(db, caller, id);
  if (query.after) await assertMessageInOrganization(caller.organizationId, query.after, "after");
  if (query.cursor) await assertMessageInOrganization(caller.organizationId, query.cursor, "cursor");

  const page = await readPage(caller.organizationId, row.id, query);
  if (page.data.length > 0 || query.wait === 0) return page;
  return waitForPage(caller, row.id, query, signal);
}
