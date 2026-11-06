import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { bucketName, storage, type Bucket } from "./index";

/** S3's floor for every part but the last. */
export const MIN_PART_BYTES = 5 * 1024 * 1024;

export const DEFAULT_PART_BYTES = 8 * 1024 * 1024;

export interface StreamUploadOptions {
  contentType: string;
  /** Every part but the last is exactly this size, which R2 requires. */
  partBytes?: number;
  signal?: AbortSignal;
  /** Runs once a multipart upload exists, so a crashed run can be aborted later. */
  onMultipartStarted?: (uploadId: string) => Promise<void>;
}

/**
 * Uploads a byte stream holding at most one part in memory. A stream that never fills a part
 * goes up as a single PutObject. A failed or aborted upload aborts its multipart upload.
 */
export async function uploadStream(
  bucket: Bucket,
  key: string,
  source: AsyncIterable<Uint8Array>,
  options: StreamUploadOptions,
): Promise<{ bytes: number }> {
  const partBytes = options.partBytes ?? DEFAULT_PART_BYTES;
  if (partBytes < MIN_PART_BYTES) throw new Error(`Parts must be at least ${MIN_PART_BYTES} bytes.`);

  const Bucket = bucketName(bucket);
  const sendOptions = { abortSignal: options.signal };
  const part = Buffer.allocUnsafe(partBytes);
  const parts: CompletedPart[] = [];
  let filled = 0;
  let bytes = 0;
  let uploadId: string | undefined;

  const sendPart = async (body: Buffer): Promise<void> => {
    if (!uploadId) {
      const created = await storage().send(
        new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: options.contentType }),
        sendOptions,
      );
      if (!created.UploadId) throw new Error("Storage returned no upload id.");
      uploadId = created.UploadId;
      await options.onMultipartStarted?.(uploadId);
    }
    const PartNumber = parts.length + 1;
    const result = await storage().send(
      new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber, Body: body }),
      sendOptions,
    );
    parts.push({ PartNumber, ETag: result.ETag });
  };

  try {
    for await (const chunk of source) {
      options.signal?.throwIfAborted();
      let offset = 0;
      while (offset < chunk.byteLength) {
        const take = Math.min(partBytes - filled, chunk.byteLength - offset);
        part.set(chunk.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        bytes += take;
        if (filled === partBytes) {
          await sendPart(part);
          filled = 0;
        }
      }
    }
    options.signal?.throwIfAborted();

    const tail = part.subarray(0, filled);
    if (!uploadId) {
      await storage().send(
        new PutObjectCommand({ Bucket, Key: key, Body: tail, ContentType: options.contentType }),
        sendOptions,
      );
      return { bytes };
    }
    if (filled > 0) await sendPart(tail);
    await storage().send(
      new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }),
      sendOptions,
    );
    return { bytes };
  } catch (err) {
    if (uploadId) await abortUpload(bucket, key, uploadId).catch(() => undefined);
    throw err;
  }
}

/** Discards an unfinished multipart upload and the parts it holds. */
export async function abortUpload(bucket: Bucket, key: string, uploadId: string): Promise<void> {
  await storage().send(new AbortMultipartUploadCommand({ Bucket: bucketName(bucket), Key: key, UploadId: uploadId }));
}
