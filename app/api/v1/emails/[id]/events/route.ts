import { and, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { keyCanAccessDomain } from "@/lib/api/keys";
import { methodPolicy } from "@/lib/api/response";
import { acquireStreamSlot, assertStreamCapacity, maxConcurrentStreams, type StreamSlot } from "@/lib/api/rate-limit";
import { sseComment, sseFrame, SSE_HEADERS } from "@/lib/api/sse";
import { withApiKey } from "@/lib/api/with-key";
import { isTerminal } from "@/lib/messages/lifecycle";
import { buildStreamFrame, eventCursorFor, streamEventsForKey, type StreamEvent } from "@/lib/messages/stream";
import { updatesChannel, type MessageUpdate } from "@/lib/messages/updates";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

export const dynamic = "force-dynamic";

const log = logger.child("v1:message-events");

/** Long enough to keep proxies from closing an idle stream, short enough to notice a dead one. */
const KEEPALIVE_MS = 25_000;
const SUBSCRIBE_TIMEOUT_MS = 3000;

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * Streams one message's lifecycle transitions until it reaches a terminal state, then closes.
 * Replays the message's existing events on connect — the common case is send-then-watch, and a
 * stream that shows nothing because the events already happened is a bad first experience — and
 * honors `Last-Event-ID` on a reconnect so only what's new since then replays.
 *
 * A message already terminal replays and closes without ever touching Redis: nothing further
 * can happen to it, so there's nothing left to hold the connection open for.
 */
async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const [message] = await db
    .select()
    .from(messages)
    // A test key reads only test mail: a live message is out of its sandbox, so it isn't there.
    .where(and(eq(messages.organizationId, key.organizationId), eq(messages.id, id), key.mode === "test" ? eq(messages.testMode, true) : undefined))
    .limit(1);

  if (!message) throw new ApiError("not_found", `No message with id ${id}.`);
  if (!keyCanAccessDomain(key, message.domainId)) {
    throw new ApiError("key_not_scoped", "This key can't read this message.");
  }

  const caller = { organizationId: key.organizationId, domainIds: key.domainIds, mode: key.mode };
  const cursor = await eventCursorFor(caller, request.headers.get("last-event-id"));
  const replay = await streamEventsForKey(caller, { after: cursor ?? undefined, messageId: message.id });

  const alreadyDone = isTerminal(message.status) || (replay.at(-1) && isTerminal(replay.at(-1)!.event.status));

  let slot: StreamSlot | undefined;
  if (!alreadyDone) {
    const outcome = await acquireStreamSlot(key.id, maxConcurrentStreams());
    assertStreamCapacity(outcome);
    slot = outcome.slot;
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      let keepalive: NodeJS.Timeout | null = null;
      let subscriber: Redis | null = null;
      let lastCursor = cursor;

      const close = () => {
        if (!open) return;
        open = false;
        if (keepalive) clearInterval(keepalive);
        void slot?.release();
        if (subscriber) void subscriber.quit().catch(() => subscriber?.disconnect());
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      };

      const write = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };

      const emit = (rows: StreamEvent[]): boolean => {
        let sawTerminal = false;
        for (const row of rows) {
          const frame = buildStreamFrame(row.event, row.message);
          write(sseFrame(frame, { id: frame.id, event: frame.type }));
          lastCursor = { occurredAt: row.event.occurredAt, id: row.event.id };
          if (isTerminal(row.event.status)) sawTerminal = true;
        }
        return sawTerminal;
      };

      write(sseComment("open"));
      if (emit(replay) || alreadyDone) {
        close();
        return;
      }

      // Subscribed before the catch-up query below runs, so nothing committed in between is
      // missed: anything already in Postgres by the time that query runs is caught there,
      // and anything after is caught by the subscription that's already active.
      const client = redis()?.duplicate({ lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
      if (!client) {
        write(sseComment("live updates unavailable"));
        close();
        return;
      }
      subscriber = client;
      client.on("error", (err) => log.warn(`subscriber error: ${safeErrorMessage(err)}`));

      try {
        await withTimeout(client.connect(), "connect");
        await withTimeout(client.subscribe(updatesChannel(key.organizationId)), "subscribe");
      } catch (err) {
        log.warn(`live updates unavailable: ${safeErrorMessage(err)}`);
        client.disconnect();
        write(sseComment("live updates unavailable"));
        close();
        return;
      }

      if (emit(await streamEventsForKey(caller, { after: lastCursor ?? undefined, messageId: message.id }))) {
        close();
        return;
      }

      // Chained rather than fired independently: two notifications arriving close together must
      // not both read `lastCursor` before either write it back, or the same row emits twice.
      let requery = Promise.resolve();
      client.on("message", (_channel, payload) => {
        let update: MessageUpdate;
        try {
          update = JSON.parse(payload) as MessageUpdate;
        } catch {
          return;
        }
        if (update.messageId !== message.id) return;
        requery = requery.then(() =>
          streamEventsForKey(caller, { after: lastCursor ?? undefined, messageId: message.id }).then((rows) => {
            if (emit(rows)) close();
          }),
        );
      });
      client.on("error", close);
      client.on("end", close);

      keepalive = setInterval(() => {
        write(sseComment("keepalive"));
        void slot?.refresh();
      }, KEEPALIVE_MS);
      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
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

export const GET = withApiKey<Context>(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
