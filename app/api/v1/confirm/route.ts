/**
 * `POST /v1/confirm { token }` (#7). No key — the token itself is the credential, the same as
 * the hosted `GET /confirm/:token` page. Not `withApiKey`: this is meant to be called from a
 * domain's own confirmation page in a visitor's browser.
 */
import { ZodError } from "zod";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/api/request-id";
import { errorResponse, json, methodPolicy, readJson } from "@/lib/api/response";
import { runWithRequestId } from "@/lib/api/request-context";
import { ApiError } from "@/lib/api/errors";
import { InvalidConfirmTokenError, redeemConfirmToken } from "@/lib/lists/opt-in";
import { confirmSchema } from "@/lib/schemas/unsubscribe";

export const dynamic = "force-dynamic";

async function post(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request);
  return runWithRequestId(requestId, async () => {
    try {
      const body = await readJson(request);
      const { token } = confirmSchema.parse(body);
      const result = await redeemConfirmToken(token);
      return json({ list_id: result.list_id, address: result.address }, 200, { [REQUEST_ID_HEADER]: requestId });
    } catch (error) {
      if (error instanceof ZodError) {
        const issue = error.issues[0];
        return errorResponse(
          new ApiError("validation_failed", issue ? `Field "token" isn't valid: ${issue.message}.` : "Request body isn't valid.", {
            field: "token",
          }),
          {},
          requestId,
        );
      }
      if (error instanceof InvalidConfirmTokenError) {
        return errorResponse(new ApiError("invalid_token", error.message), {}, requestId);
      }
      return errorResponse(error, {}, requestId);
    }
  });
}

export const POST = post;

const { rejected, options } = methodPolicy("POST");
export const GET = rejected;
export const PATCH = rejected;
export const PUT = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
