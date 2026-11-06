import type { ExportJobRow, ExportKind, ExportStatus } from "@/lib/db/schema/exports";
import { exportDownloadUrl } from "./download";

export interface SerializedExport {
  id: string;
  kind: ExportKind;
  status: ExportStatus;
  count: number | null;
  filename: string | null;
  /** A signed link to the artifact, minted fresh on every read. Present only while ready. */
  download_url: string | null;
  error: string | null;
  requested_at: string;
  started_at: string | null;
  ready_at: string | null;
  failed_at: string | null;
  expires_at: string | null;
}

/** Mints a fresh signed URL on every call — never stored, since a stored one would outlive its TTL. */
export async function serializeExport(row: ExportJobRow): Promise<SerializedExport> {
  const downloadUrl =
    row.status === "ready" && row.objectKey && row.contentType && row.filename
      ? await exportDownloadUrl(row.objectKey, row.filename, row.contentType)
      : null;

  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    count: row.count,
    filename: row.filename,
    download_url: downloadUrl,
    error: row.error,
    requested_at: row.requestedAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    ready_at: row.readyAt?.toISOString() ?? null,
    failed_at: row.failedAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
  };
}
