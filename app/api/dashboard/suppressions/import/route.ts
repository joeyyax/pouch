import { ApiError } from "@/lib/api/errors";
import { errorResponse, json, readCapped } from "@/lib/api/response";
import { requireOrganizationWrite } from "@/lib/dashboard/session";
import { isSameOrigin } from "@/lib/dashboard/same-origin";
import { importSuppressionFile } from "@/lib/messages/suppression-manage";
import { importSuppressionsCsvQuerySchema } from "@/lib/schemas/suppression";
import { withRequestId } from "@/lib/api/request-context";

export const dynamic = "force-dynamic";

/** A CSV file from the suppressions screen. Session-authenticated; reason and source ride in the query. */
async function post(request: Request): Promise<Response> {
  try {
    const session = await requireOrganizationWrite("import suppressions");
    if (!isSameOrigin(request)) throw new ApiError("invalid_key", "This request didn't come from the dashboard.");
    const query = importSuppressionsCsvQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) {
      throw new ApiError("validation_failed", "Choose a reason and keep the source under 100 characters.");
    }
    const result = await importSuppressionFile(session, await readCapped(request), {
      reason: query.data.reason,
      source: query.data.source ?? null,
    });
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = withRequestId(post);
