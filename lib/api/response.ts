import { ApiError } from "./errors";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id";
import { logger } from "@/lib/logger";
import { reportError } from "@/lib/errors/report";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("api");

const JSON_HEADERS = { "content-type": "application/json" };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export function errorResponse(error: unknown, headers: Record<string, string> = {}, requestId?: string): Response {
  const responseHeaders = requestId ? { ...headers, [REQUEST_ID_HEADER]: requestId } : headers;
  if (error instanceof ApiError) {
    return json(error.toBody(requestId), error.status, { ...responseHeaders, ...error.headers });
  }
  // Tagged explicitly rather than left to ambient log context: this runs in the catch block
  // after the request's async context has already unwound.
  const tag = requestId ? ` [${requestId}]` : "";
  log.error(`unhandled request error${tag}: ${safeErrorMessage(error)}`);
  reportError(error, { requestId, errorCode: "provider_unavailable" });
  return json(
    {
      error: {
        code: "provider_unavailable",
        message: "The service can't complete this request right now.",
        ...(requestId ? { request_id: requestId } : {}),
      },
    },
    503,
    responseHeaders,
  );
}

/**
 * A route's handler for the verbs it doesn't implement, and the OPTIONS answer that lists the
 * ones it does. Next answers an unexported verb with an empty 405, and its built-in OPTIONS
 * would count the rejecting handlers as supported.
 */
export function methodPolicy(...allowed: string[]) {
  const allow = [...allowed.flatMap((method) => (method === "GET" ? ["GET", "HEAD"] : [method])), "OPTIONS"].join(", ");
  return {
    rejected: async (request: Request): Promise<Response> =>
      errorResponse(
        new ApiError("method_not_allowed", `${request.method} isn't allowed on this route. Use ${allowed.join(" or ")}.`, {
          headers: { allow },
        }),
        {},
        resolveRequestId(request),
      ),
    options: async (request: Request): Promise<Response> =>
      new Response(null, { status: 204, headers: { allow, [REQUEST_ID_HEADER]: resolveRequestId(request) } }),
  };
}

/** Largest request body accepted, before base64 attachments are decoded. */
export const MAX_BODY_BYTES = 30 * 1024 * 1024;

function tooLarge(): ApiError {
  return new ApiError("attachment_too_large", "Request body exceeds the 30 MB limit.", {
    detail: { limit_bytes: MAX_BODY_BYTES },
  });
}

/**
 * Reads a request body to text, stopping as soon as the running total crosses the cap. A
 * missing or understated Content-Length must not let a caller force the whole body into memory.
 * Webhook receivers read the raw body this way: the bytes the signature covers, unparsed.
 */
export async function readCapped(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      log.warn(`request body crossed the ${MAX_BODY_BYTES} byte cap at ${total} bytes`);
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
}

/** Parses a JSON request body, mapping malformed input to the `invalid_json` envelope. */
export async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError("attachment_too_large", "Request body exceeds the 30 MB limit.", {
      detail: { limit_bytes: MAX_BODY_BYTES, size_bytes: declared },
    });
  }

  const raw = await readCapped(request);

  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError("invalid_json", "Request body isn't valid JSON.");
  }
}
