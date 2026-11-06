import { z } from "zod";
import { clientIpBucket } from "@/lib/api/client-ip";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { isErrorReportingArmed, reportError } from "./report";

/** A report is a route, a digest and a short message; anything bigger isn't one. */
export const MAX_CLIENT_ERROR_BYTES = 2048;
/** Per client address, per minute. A broken screen throws once per mount, not once per second. */
export const CLIENT_ERROR_RATE_LIMIT = 10;

const reportSchema = z
  .object({
    route: z.string().max(200).regex(/^\/[\w\-./~%]*$/),
    digest: z.string().max(64).regex(/^[\w-]+$/).optional(),
    message: z.string().max(300).optional(),
  })
  .strict()
  .refine((report) => report.digest !== undefined || report.message !== undefined);

/** Reads the body up to the cap, or null once it's over. A missing Content-Length can't force more into memory. */
async function readBounded(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CLIENT_ERROR_BYTES) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CLIENT_ERROR_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const status = (code: number, headers?: Record<string, string>) => new Response(null, { status: code, headers });

/**
 * Takes a browser's render error and hands it to the reporter, which scrubs it. Answers 204 and
 * does nothing when no DSN is set. The JSON content type is required so another site's page
 * can't post here without a preflight, which this route never answers.
 */
export async function ingestClientError(request: Request): Promise<Response> {
  if (!isErrorReportingArmed()) return status(204);

  if (!request.headers.get("content-type")?.startsWith("application/json")) return status(415);

  const limit = await consumeRateLimit(`client-errors:${clientIpBucket(request)}`, CLIENT_ERROR_RATE_LIMIT);
  if (limit.exceeded) return status(429, { "Retry-After": String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))) });

  const raw = await readBounded(request);
  if (raw === null) return status(413);

  let parsed: z.infer<typeof reportSchema>;
  try {
    parsed = reportSchema.parse(JSON.parse(raw));
  } catch {
    return status(422);
  }

  const text = parsed.message ? `Client render error: ${parsed.message}` : `Client render error, digest ${parsed.digest}`;
  const error = new Error(text);
  error.name = "ClientRenderError";
  // This route's own frames would read as where the error happened.
  error.stack = `${error.name}: ${error.message}`;
  reportError(error, { route: parsed.route, routeType: "client", digest: parsed.digest });
  return status(204);
}
