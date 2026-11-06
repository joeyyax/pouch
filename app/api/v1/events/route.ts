import { ZodError } from "zod";
import type { Redis } from "ioredis";
import { ApiError } from "@/lib/api/errors";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { methodPolicy } from "@/lib/api/response";
import { acquireStreamSlot, assertStreamCapacity, maxConcurrentStreams } from "@/lib/api/rate-limit";
import { sseComment, sseFrame, SSE_HEADERS } from "@/lib/api/sse";
import { withApiKey } from "@/lib/api/with-key";
import { buildStreamFrame, eventCursorFor, streamEventsForKey, type StreamCursor, type StreamEvent } from "@/lib/messages/stream";
import { updatesChannel } from "@/lib/messages/updates";
import { listEventsSchema } from "@/lib/schemas/event";
import { redis } from "@/lib/redis";
import { dbNow } from "@/lib/db/clock";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

export const dynamic = "force-dynamic";

const log = logger.child("v1:events");

const KEEPALIVE_MS = 25_000;
const SUBSCRIBE_TIMEOUT_MS = 3000;

/**
 * Streams every lifecycle transition the key can see, oldest first, optionally filtered by
 * `type`. Unlike `GET /v1/emails/:id/events` this never reaches a terminal state on its own —
 * it stays open until the client disconnects — so it always needs Redis and always spends a
 * concurrent-stream slot.
 *
 * A fresh connect with no `Last-Event-ID` starts from now rather than replaying the
 * organization's whole history: that replay is bounded and useful for one message, but
 * unbounded and expensive for everything a key can see. `Last-Event-ID` still catches a
 * reconnect up on whatever it missed, capped at `MAX_STREAM_REPLAY`.
 */
async function get(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  let type: string | undefined;
  try {
    ({ type } = listEventsSchema.parse(query));
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      throw new ApiError("validation_failed", `Field "type" isn't valid: ${issue?.message ?? "invalid value"}.`, { field: "type" });
    }
    throw error;
  }

  const outcome = await acquireStreamSlot(key.id, maxConcurrentStreams());
  assertStreamCapacity(outcome);
  const slot = outcome.slot;

  const caller = { organizationId: key.organizationId, domainIds: key.domainIds, mode: key.mode };
  const cursor = await eventCursorFor(caller, request.headers.get("last-event-id"));

  // Read before the stream is constructed, not inside start(): a throw in there lands after
  // `new Response(stream)` has already gone back to the client and before `close()` exists, so
  // the stream slot acquired above is held until its TTL expires rather than released.
  const startCursor: StreamCursor = cursor ?? { occurredAt: await dbNow(), id: "" };

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      let keepalive: NodeJS.Timeout | null = null;
      let subscriber: Redis | null = null;
      // No Last-Event-ID means start from now: everything a key can see is potentially a lot of
      // history, and this endpoint is a live tail, not an export.
      let lastCursor: StreamCursor | undefined = startCursor;

      const close = () => {
        if (!open) return;
        open = false;
        if (keepalive) clearInterval(keepalive);
        void slot.release();
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

      const emit = (rows: StreamEvent[]): void => {
        for (const row of rows) {
          const frame = buildStreamFrame(row.event, row.message);
          write(sseFrame(frame, { id: frame.id, event: frame.type }));
          lastCursor = { occurredAt: row.event.occurredAt, id: row.event.id };
        }
      };

      write(sseComment("open"));

      // Subscribed before every catch-up query below, so nothing committed in between is
      // missed — see the per-message route for the same reasoning.
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

      emit(await streamEventsForKey(caller, { after: lastCursor, type }));

      // Chained rather than fired independently: two notifications arriving close together must
      // not both read `lastCursor` before either write it back, or the same row emits twice.
      let requery = Promise.resolve();
      client.on("message", () => {
        // The published payload only names one message; re-querying from the cursor is what
        // catches every transition since, including more than one that landed between ticks.
        requery = requery.then(() => streamEventsForKey(caller, { after: lastCursor, type }).then(emit));
      });
      client.on("error", close);
      client.on("end", close);

      keepalive = setInterval(() => {
        write(sseComment("keepalive"));
        void slot.refresh();
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

export const GET = withApiKey(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
