import { ApiError } from "@/lib/api/errors";
import { assertFeatureEnabled } from "@/lib/features";
import { errorResponse, json, readCapped } from "@/lib/api/response";
import { isSameOrigin } from "@/lib/dashboard/same-origin";
import { requireOrganizationWrite, sessionActor } from "@/lib/dashboard/session";
import { listFor } from "@/lib/lists";
import { importCounts, importMemberCsv } from "@/lib/lists/import";
import { withRequestId } from "@/lib/api/request-context";

export const dynamic = "force-dynamic";

/** A CSV file from the list page. Session-authenticated, same-origin only. */
async function post(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  try {
    const session = await requireOrganizationWrite("import list members");
    await assertFeatureEnabled("lists");
    if (!isSameOrigin(request)) throw new ApiError("invalid_key", "This request didn't come from the dashboard.");
    const caller = { organizationId: session.organizationId, domainIds: [], actor: sessionActor(session) };
    const list = await listFor(caller, id);
    const result = await importMemberCsv(caller, list, await readCapped(request));
    return json({ ...importCounts(result), errors: result.errors });
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = withRequestId(post);
