/**
 * `fetch` with a deadline, body included.
 *
 * Node's `fetch` has no default timeout, so an unresponsive host holds the caller forever. Inside
 * a worker loop that matters more than it looks: every loop guards re-entry with an in-flight
 * promise it clears in `.finally`, so a call that never settles means that loop never runs again
 * and never logs why.
 *
 * The body is read here rather than by the caller because the deadline has to cover it. A server
 * that returns headers promptly and then stalls the body hangs a caller just as completely, and
 * clearing the timer once `fetch` resolves would leave exactly that gap — `lib/providers/adapters/mailpace.ts`
 * already got this right and this is the same shape.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } catch (err) {
    if (controller.signal.aborted) throw controller.signal.reason ?? err;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How long a socket may sit idle mid-transfer before the AWS SDK gives up on it. This is the one
 * that catches a blackholed connection, and it's independent of how long a legitimate transfer
 * takes — which is why the request deadlines below can be generous without reopening the hang.
 */
const SOCKET_IDLE_TIMEOUT_MS = 30_000;

/**
 * Connection, idle and total deadlines for an AWS SDK client. The SDK builds its own
 * `NodeHttpHandler` from this shape, so it needs no extra dependency.
 *
 * `throwOnRequestTimeout` is not optional decoration: without it `@smithy/node-http-handler` logs
 * `a request has exceeded the configured N ms requestTimeout` and lets the request carry on
 * forever. The opt-in exists because `requestTimeout` was historically implemented as a socket
 * idle timeout, and the fix couldn't change that silently. Left off, every deadline here is a
 * warning in a log nobody reads.
 *
 * `requestTimeout` is therefore total request-and-response duration, not per socket operation, so
 * it has to clear the largest legitimate transfer — a 25 MB attachment (`lib/providers/adapters/ses/settings.ts`)
 * over a slow link — while staying under the worker's five-minute lock timeout
 * (`lib/messages/queue.ts`), so a hung request can never outlive the lock on the row it's working.
 */
export function awsRequestHandler(requestTimeoutMs: number): {
  requestHandler: {
    connectionTimeout: number;
    socketTimeout: number;
    requestTimeout: number;
    throwOnRequestTimeout: true;
  };
} {
  return {
    requestHandler: {
      connectionTimeout: 5_000,
      socketTimeout: SOCKET_IDLE_TIMEOUT_MS,
      requestTimeout: requestTimeoutMs,
      throwOnRequestTimeout: true,
    },
  };
}
