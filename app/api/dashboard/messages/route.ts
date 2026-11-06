import { getSession } from "@/lib/auth/session";
import { updatesChannel } from "@/lib/messages/updates";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { withRequestId } from "@/lib/api/request-context";
import { safeErrorMessage } from "@/lib/errors/scrub";

export const dynamic = "force-dynamic";

const log = logger.child("dashboard:stream");

/** Long enough to keep proxies from closing an idle stream, short enough to notice a dead one. */
const KEEPALIVE_MS = 25_000;

/** How long to wait for the connection and the subscription before calling live updates off. */
const SUBSCRIBE_TIMEOUT_MS = 3000;

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Tells a buffering proxy to pass each chunk through as it arrives.
  "x-accel-buffering": "no",
};

/**
 * Streams this organization's message status changes to the dashboard. Session-authenticated,
 * not key-authenticated: it isn't part of the API.
 *
 * With no Redis, this answers 503 once and closes. The client stops asking and the list stays
 * exactly as the server rendered it — stale, but never blank and never an error on the page.
 */
async function get(request: Request): Promise<Response> {
  const session = await getSession();
  const organizationId = (session?.user as { organizationId?: string } | undefined)?.organizationId;
  if (!organizationId) {
    return new Response(JSON.stringify({ error: { code: "invalid_key", message: "Sign in first." } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // A dedicated connection: a subscribed client can't run anything else. It connects on
  // demand and gives up rather than retrying forever, so a Redis that's gone fails the
  // request instead of leaving it open.
  const client = redis()?.duplicate({ lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  if (!client) return unavailable();

  const channel = updatesChannel(organizationId);

  // Connect and subscribe before answering. Returning the stream first sends the response
  // headers, the browser fires onopen, and the page says "Live" while nothing is listening —
  // the one failure this route must never report as working.
  client.on("error", (err) => log.warn(`subscriber error: ${safeErrorMessage(err)}`));
  try {
    await within(client.connect(), "connect");
    await within(client.subscribe(channel), "subscribe");
  } catch (err) {
    log.warn(`live updates unavailable: ${safeErrorMessage(err)}`);
    client.disconnect();
    return unavailable();
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      let keepalive: NodeJS.Timeout | null = null;

      const close = () => {
        if (!open) return;
        open = false;
        if (keepalive) clearInterval(keepalive);
        void client.quit().catch(() => client.disconnect());
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

      client.on("message", (_channel, payload) => write(`data: ${payload}\n\n`));
      // A connection lost after the subscription took ends the stream; the client retries.
      client.on("error", close);
      client.on("end", close);

      // A first byte tells the client the stream is up, rather than leaving it to guess.
      write(": open\n\n");
      keepalive = setInterval(() => write(": keepalive\n\n"), KEEPALIVE_MS);
      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

function unavailable(): Response {
  return new Response(
    JSON.stringify({
      error: { code: "provider_unavailable", message: "Live updates are off. Reload to see changes." },
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

/** Rejects rather than waiting on a Redis that isn't answering. */
export async function within(work: Promise<unknown>, what: string): Promise<void> {
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

export const GET = withRequestId(get);
