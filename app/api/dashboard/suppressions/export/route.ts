import { recordActivity } from "@/lib/activity/record";
import { errorResponse } from "@/lib/api/response";
import { requireOrganizationWrite, sessionActor } from "@/lib/dashboard/session";
import { toByteStream } from "@/lib/exports/stream";
import { suppressionCsvLines } from "@/lib/messages/suppression-csv";
import { withRequestId } from "@/lib/api/request-context";
import { suppressionListWhere } from "@/lib/dashboard/suppressions";
import { readSuppressionListFilters } from "@/lib/dashboard/views/suppressions";

export const dynamic = "force-dynamic";

/** The suppression list as CSV, narrowed by the screen's filters. */
async function get(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const filters = readSuppressionListFilters((name) => params.get(name));

  try {
    const session = await requireOrganizationWrite("export the suppression list");

    await recordActivity({
      organizationId: session.organizationId,
      action: "system.export.created",
      actor: sessionActor(session),
      metadata: { kind: "suppressions_csv", search: filters.search ?? null },
    });

    const where = await suppressionListWhere(session.organizationId, filters, session.timeZone);

    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(toByteStream(suppressionCsvLines(session.organizationId, where)), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="suppressions-${stamp}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withRequestId(get);
