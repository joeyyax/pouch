/**
 * `POST /v1/unsubscribe { token, scope }` (#7). No key, CORS-open — this is the redemption
 * target for a domain's own branded `unsubscribe_url` page, called directly from a visitor's
 * browser on whatever origin that page is hosted on. `List-Unsubscribe-Post` never points here:
 * a mail client posts straight to the hosted `/u/:token` page instead (see app/u/[token]).
 */
import { ZodError } from "zod";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/api/request-id";
import { errorResponse, json, readJson } from "@/lib/api/response";
import { runWithRequestId } from "@/lib/api/request-context";
import { ApiError } from "@/lib/api/errors";
import { InvalidUnsubscribeTokenError, redeemUnsubscribeToken } from "@/lib/lists/unsubscribe";
import { unsubscribeRedeemSchema } from "@/lib/schemas/unsubscribe";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

async function post(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request);
  return runWithRequestId(requestId, async () => {
    try {
      const body = await readJson(request);
      const { token, scope } = unsubscribeRedeemSchema.parse(body);
      const result = await redeemUnsubscribeToken(token, scope);
      return json(
        { scope: result.scope, list_name: result.list_name, domain_name: result.domain_name },
        200,
        { ...CORS_HEADERS, [REQUEST_ID_HEADER]: requestId },
      );
    } catch (error) {
      if (error instanceof ZodError) {
        const issue = error.issues[0];
        return errorResponse(
          new ApiError("validation_failed", issue ? `Field "${issue.path.join(".") || "token"}" isn't valid: ${issue.message}.` : "Request body isn't valid."),
          CORS_HEADERS,
          requestId,
        );
      }
      if (error instanceof InvalidUnsubscribeTokenError) {
        return errorResponse(new ApiError("invalid_token", error.message), CORS_HEADERS, requestId);
      }
      return errorResponse(error, CORS_HEADERS, requestId);
    }
  });
}

export async function OPTIONS(request: Request): Promise<Response> {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, [REQUEST_ID_HEADER]: resolveRequestId(request) } });
}

export const POST = post;

// Named `rejected`, matching the { rejected, options } destructure every other route uses —
// scripts/check-api-docs.ts and its coverage test key off that exact binding name to tell a
// served verb from a 405-only one.
async function rejected(request: Request): Promise<Response> {
  return errorResponse(
    new ApiError("method_not_allowed", `${request.method} isn't allowed on this route. Use POST.`, { headers: { allow: "POST, OPTIONS" } }),
    CORS_HEADERS,
    resolveRequestId(request),
  );
}

export const GET = rejected;
export const PATCH = rejected;
export const PUT = rejected;
export const DELETE = rejected;
