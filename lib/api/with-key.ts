import { assertFeatureEnabled, featureForPath } from "@/lib/features";
import { logger } from "@/lib/logger";
import { clientIpBucket } from "./client-ip";
import { ApiError } from "./errors";
import type { ApiKeyRow, OrganizationKeyRow } from "./keys";
import { authenticateKey, recordKeyUse, requireAdminKey, requireOrganizationKey } from "./keys";
import { assertWithinRateLimit, consumeRateLimit, peekRateLimit, rateLimitHeaders } from "./rate-limit";
import { runWithRequestId } from "./request-context";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id";
import { errorResponse } from "./response";
import { safeErrorMessage } from "@/lib/errors/scrub";

type Handler<Context, Key = OrganizationKeyRow> = (request: Request, key: Key, context: Context) => Promise<Response>;

const log = logger.child("api");

/** Failed authentications allowed per minute from one address, before the key lookup stops running. */
function failedAuthLimit(): number {
  return Number(process.env.FAILED_AUTH_RATE_LIMIT ?? "20");
}

/**
 * Authenticates the bearer key, applies its rate limit, and maps a thrown ApiError (or
 * anything else) to the error envelope. Rate-limit headers land on every response once a key
 * has resolved; a 401 has no key to report a limit for.
 */
function withAuthenticatedKey<Context, Key extends ApiKeyRow>(narrow: (key: ApiKeyRow) => Key, handler: Handler<Context, Key>) {
  return async (request: Request, context?: Context): Promise<Response> => {
    const requestId = resolveRequestId(request);
    let headers: Record<string, string> = { [REQUEST_ID_HEADER]: requestId };
    const failures = `auth-failures:${clientIpBucket(request)}`;
    const failureLimit = failedAuthLimit();
    try {
      // Read the address's failures before the lookup, count against them after: a caller who
      // authenticates never touches this bucket, and one who can't stops reaching the database.
      assertWithinRateLimit(await peekRateLimit(failures, failureLimit), "this address");

      let key: ApiKeyRow;
      try {
        key = await authenticateKey(request);
      } catch (error) {
        if (error instanceof ApiError && error.code === "invalid_key") {
          await consumeRateLimit(failures, failureLimit);
        }
        throw error;
      }

      // Every authenticated request, whatever it goes on to do, and never a reason to fail one.
      await recordKeyUse(key.id).catch((error: unknown) => {
        log.warn(`couldn't record key use for ${key.id}: ${safeErrorMessage(error)}`);
      });

      const limit = await consumeRateLimit(key.id, key.rateLimit);
      headers = { ...headers, ...rateLimitHeaders(limit) };
      assertWithinRateLimit(limit);

      const feature = featureForPath(new URL(request.url).pathname);
      if (feature) await assertFeatureEnabled(feature);

      const response = await runWithRequestId(requestId, () => handler(request, narrow(key), context as Context));
      for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
      return response;
    } catch (error) {
      return errorResponse(error, headers, requestId);
    }
  };
}

/** An ordinary `/v1` route: an admin key gets `403 organization_key_required`. */
export function withApiKey<Context = undefined>(handler: Handler<Context>) {
  return withAuthenticatedKey<Context, OrganizationKeyRow>(requireOrganizationKey, handler);
}

/** `/mcp`, which serves both scopes. Each tool call re-authenticates through the route it wraps. */
export function withAnyKey<Context = undefined>(handler: Handler<Context, ApiKeyRow>) {
  return withAuthenticatedKey<Context, ApiKeyRow>((key) => key, handler);
}

/** `/v1/admin/*`: an organization key gets `403 admin_key_required`. */
export function withAdminKey<Context = undefined>(handler: Handler<Context, ApiKeyRow>) {
  return withAuthenticatedKey<Context, ApiKeyRow>((key) => {
    requireAdminKey(key);
    return key;
  }, handler);
}
