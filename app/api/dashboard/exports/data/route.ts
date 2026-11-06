import { countOrganizationData, organizationDataNdjsonLines } from "@/lib/exports/data";
import { toByteStream } from "@/lib/exports/stream";
import { recordExport } from "@/lib/exports/audit";
import { requireExportSession } from "@/lib/exports/session";
import { exportFilename } from "@/lib/wire";
import { withRequestId } from "@/lib/api/request-context";

export const dynamic = "force-dynamic";

/** Suppressions and domain configuration (including DNS records and layouts), whole organization. */
async function get(): Promise<Response> {
  const session = await requireExportSession();
  if (session instanceof Response) return session;

  const count = await countOrganizationData(session.organizationId);
  await recordExport({
    organizationId: session.organizationId,
    actor: session.actor,
    kind: "data",
    count,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const stream = toByteStream(organizationDataNdjsonLines(session.organizationId));

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename("data", stamp, "ndjson")}"`,
      "cache-control": "no-store",
    },
  });
}

export const GET = withRequestId(get);
