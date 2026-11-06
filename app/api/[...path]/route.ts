import { ApiError } from "@/lib/api/errors";
import { resolveRequestId } from "@/lib/api/request-id";
import { errorResponse } from "@/lib/api/response";

export const dynamic = "force-dynamic";

// Next answers an unmatched path with an HTML 404. Everything under /api answers in the envelope.
async function unmatched(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  return errorResponse(new ApiError("not_found", `No route matches ${request.method} ${pathname}.`), {}, resolveRequestId(request));
}

export const GET = unmatched;
export const POST = unmatched;
export const PUT = unmatched;
export const PATCH = unmatched;
export const DELETE = unmatched;
export const OPTIONS = unmatched;
