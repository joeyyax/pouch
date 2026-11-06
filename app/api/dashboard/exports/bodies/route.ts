import { countExportableMessages } from "@/lib/exports/messages-query";
import { bodiesZipChunks } from "@/lib/exports/bodies";
import { exportFiltersFromSearchParams } from "@/lib/exports/params";
import { decideExport } from "@/lib/exports/create";
import { toByteStream } from "@/lib/exports/stream";
import { serializeExport } from "@/lib/exports/serialize";
import { exportFilename } from "@/lib/wire";
import { json } from "@/lib/api/response";
import { jsonError, requireExportSession } from "@/lib/exports/session";
import { withRequestId } from "@/lib/api/request-context";

export const dynamic = "force-dynamic";

/**
 * Message bodies and attachments for the current filter, one .eml per message inside a
 * .zip. A message whose body has aged out of retention still gets an entry — its .eml says
 * why in place of the body, per docs/product/brief.md "the record is yours". Streamed
 * directly below lib/exports/limits.ts's ceiling; past it, `decideExport` queues a worker
 * job and this returns 202 with the export's poll id instead of a file.
 */
async function get(request: Request): Promise<Response> {
  const session = await requireExportSession();
  if (session instanceof Response) return session;

  const url = new URL(request.url);
  const filters = await exportFiltersFromSearchParams(session.organizationId, url.searchParams);

  const count = await countExportableMessages(session.organizationId, filters);
  if (count === 0) {
    return jsonError(404, "not_found", "No messages match this filter.");
  }

  const decision = await decideExport({
    organizationId: session.organizationId,
    actor: session.actor,
    kind: "bodies",
    filters,
    count,
  });

  if (decision.queued) {
    return json(await serializeExport(decision.record), 202);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const stream = toByteStream(bodiesZipChunks(session.organizationId, filters));

  return new Response(stream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${exportFilename("bodies", stamp, "zip")}"`,
      "cache-control": "no-store",
    },
  });
}

export const GET = withRequestId(get);
