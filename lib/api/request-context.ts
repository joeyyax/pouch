import { AsyncLocalStorage } from "node:async_hooks";
import { setRequestIdProvider } from "@/lib/logger";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id";

const storage = new AsyncLocalStorage<string>();

setRequestIdProvider(() => storage.getStore());

/** Runs `fn` with `requestId` attached to every log line emitted anywhere in its call graph. */
export function runWithRequestId<T>(requestId: string | null | undefined, fn: () => T): T {
  return requestId ? storage.run(requestId, fn) : fn();
}

/** The id of the request in scope, for a row that has to carry it past the response. */
export function currentRequestId(): string | undefined {
  return storage.getStore();
}

/**
 * Binds a request id to a route that isn't key-authenticated — provider webhooks, inbound mail,
 * the dashboard's own endpoints — and echoes it on the response. `withApiKey` does this itself.
 */
export function withRequestId<Rest extends unknown[]>(
  handler: (request: Request, ...rest: Rest) => Promise<Response>,
): (request: Request, ...rest: Rest) => Promise<Response> {
  return async (request, ...rest) => {
    const requestId = resolveRequestId(request);
    const response = await runWithRequestId(requestId, () => handler(request, ...rest));
    // A redirect's headers are immutable; correlation isn't worth failing the response over.
    try {
      response.headers.set(REQUEST_ID_HEADER, requestId);
    } catch {
      // Left as it came back.
    }
    return response;
  };
}
