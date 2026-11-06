import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storage, storageBucket } from "@/lib/storage";

/** A filename safe inside a quoted header value, with the original kept in `filename*`. */
export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** A link to one private object that expires in `ttlSeconds`. Minted on read, never stored. */
export async function privateDownloadUrl(objectKey: string, filename: string, contentType: string, ttlSeconds: number): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: storageBucket(),
    Key: objectKey,
    ResponseContentDisposition: attachmentDisposition(filename),
    ResponseContentType: contentType,
  });
  return getSignedUrl(storage(), command, { expiresIn: ttlSeconds });
}
