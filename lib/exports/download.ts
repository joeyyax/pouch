/**
 * A ready export's artifact is fetched by a signed URL, not proxied through this process —
 * the file already left the S3-compatible bucket the same way a message body does, and there's
 * no reason to hold a Next.js request open streaming bytes it isn't transforming.
 */
import { privateDownloadUrl } from "@/lib/storage/links";

/** How long a generated link stays valid. Short: a fresh one is a cheap re-read of a ready row. */
export const EXPORT_DOWNLOAD_URL_TTL_SECONDS = 300;

export async function exportDownloadUrl(objectKey: string, filename: string, contentType: string): Promise<string> {
  return privateDownloadUrl(objectKey, filename, contentType, EXPORT_DOWNLOAD_URL_TTL_SECONDS);
}
