import { countExportableMessages } from "@/lib/exports/messages-query";
import { messagesCsvLines, messagesNdjsonLines } from "@/lib/exports/log";
import { exportFiltersFromSearchParams } from "@/lib/exports/params";
import { decideExport } from "@/lib/exports/create";
import { toByteStream } from "@/lib/exports/stream";
import { serializeExport } from "@/lib/exports/serialize";
import { json } from "@/lib/api/response";
import { requireExportSession } from "@/lib/exports/session";
import { exportFilename } from "@/lib/wire";
import { withRequestId } from "@/lib/api/request-context";

export const dynamic = "force-dynamic";

/**
 * The messages screen's current filter, exported as CSV (the log, one row per message) or
 * NDJSON (full fidelity, nested events and envelope fields a CSV flattens badly). Streamed
 * directly below lib/exports/limits.ts's ceiling; past it, `decideExport` queues a worker job
 * and this returns 202 with the export's poll id instead of a file.
 */
async function get(request: Request): Promise<Response> {
  const session = await requireExportSession();
  if (session instanceof Response) return session;

  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "ndjson" ? "ndjson" : "csv";
  const filters = await exportFiltersFromSearchParams(session.organizationId, url.searchParams);

  const count = await countExportableMessages(session.organizationId, filters);
  const kind = format === "csv" ? "log_csv" : "log_ndjson";
  const decision = await decideExport({ organizationId: session.organizationId, actor: session.actor, kind, filters, count });

  if (decision.queued) {
    return json(await serializeExport(decision.record), 202);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const stream =
    format === "csv"
      ? toByteStream(messagesCsvLines(session.organizationId, filters))
      : toByteStream(messagesNdjsonLines(session.organizationId, filters));

  return new Response(stream, {
    headers: {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename("messages", stamp, format === "csv" ? "csv" : "ndjson")}"`,
      "cache-control": "no-store",
    },
  });
}

export const GET = withRequestId(get);
