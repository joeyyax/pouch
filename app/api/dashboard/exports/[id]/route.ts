import { json } from "@/lib/api/response";
import { exportRecordFor } from "@/lib/exports/records";
import { serializeExport } from "@/lib/exports/serialize";
import { jsonError, requireExportSession } from "@/lib/exports/session";
import { withRequestId } from "@/lib/api/request-context";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/** Polls a queued export's status. Scoped to the session's organization — a foreign id reads as not_found. */
async function get(_request: Request, context: Context): Promise<Response> {
  const session = await requireExportSession();
  if (session instanceof Response) return session;

  const { id } = await context.params;
  const record = await exportRecordFor(session.organizationId, id);
  if (!record) return jsonError(404, "not_found", `No export with id ${id}.`);

  return json(await serializeExport(record));
}

export const GET = withRequestId(get);
