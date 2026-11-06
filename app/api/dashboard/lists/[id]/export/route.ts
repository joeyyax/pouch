import { errorResponse } from "@/lib/api/response";
import { assertFeatureEnabled } from "@/lib/features";
import { requireOrganizationWrite, sessionActor } from "@/lib/dashboard/session";
import { listFor } from "@/lib/lists";
import { memberCsv, memberCsvHeaders } from "@/lib/lists/csv-export";
import { withRequestId } from "@/lib/api/request-context";

export const dynamic = "force-dynamic";

/** A list's members as CSV, for the list page. Session-authenticated. */
async function get(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  try {
    const session = await requireOrganizationWrite("export this list");
    await assertFeatureEnabled("lists");
    const list = await listFor({ organizationId: session.organizationId, domainIds: [], actor: sessionActor(session) }, id);
    return new Response(await memberCsv(list.id), { headers: memberCsvHeaders(list.name) });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withRequestId(get);
