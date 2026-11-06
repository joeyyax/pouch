import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { awsRequestHandler } from "@/lib/fetch-timeout";

let client: S3Client | null = null;

/** Which bucket a call names. `private` holds bodies and is never public; `assets` is served by its own domain. */
export type Bucket = "private" | "assets";

/** The private bucket's name. Every body write needs it, so it's not optional. */
export function storageBucket(): string {
  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) throw new Error("STORAGE_BUCKET isn't set.");
  return bucket;
}

/** The public assets bucket's name, or null when layout assets aren't configured. */
export function assetsBucket(): string | null {
  return process.env.STORAGE_ASSETS_BUCKET || null;
}

/** Base URL assets are served from, or null when the assets bucket isn't configured. */
export function assetsBaseUrl(): string | null {
  if (!assetsBucket()) return null;
  return process.env.STORAGE_ASSETS_BASE_URL || null;
}

/** Public URL for an asset key, or null when the assets bucket or its base URL isn't set. */
export function assetUrl(key: string): string | null {
  const base = assetsBaseUrl();
  return base ? `${base.replace(/\/$/, "")}/${key}` : null;
}

// Total transfer ceiling, not a hang detector — the 30s idle socket timeout in awsRequestHandler
// is that. Sized to clear the largest legitimate object (a 25 MB attachment over a slow link)
// while staying well inside the worker's five-minute lock timeout (lib/messages/queue.ts).
export const STORAGE_TIMEOUT_MS = 120_000;

export function bucketName(bucket: Bucket): string {
  if (bucket === "private") return storageBucket();
  const name = assetsBucket();
  if (!name) throw new Error("STORAGE_ASSETS_BUCKET isn't set.");
  return name;
}

export function storage(): S3Client {
  if (!client) {
    const endpoint = process.env.STORAGE_ENDPOINT;
    if (!endpoint) throw new Error("STORAGE_ENDPOINT isn't set.");
    client = new S3Client({
      endpoint,
      ...awsRequestHandler(STORAGE_TIMEOUT_MS),
      region: process.env.STORAGE_REGION ?? "auto",
      forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE !== "false",
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? "",
      },
    });
  }
  return client;
}

export async function putObject(
  bucket: Bucket,
  key: string,
  body: string | Uint8Array,
  contentType: string,
): Promise<void> {
  await storage().send(new PutObjectCommand({ Bucket: bucketName(bucket), Key: key, Body: body, ContentType: contentType }));
}

/** Throws when the object can't be read. A body the worker can't fetch must retry, not send empty. */
export async function getObject(bucket: Bucket, key: string): Promise<string> {
  const result = await storage().send(new GetObjectCommand({ Bucket: bucketName(bucket), Key: key }));
  const body = await result.Body?.transformToString();
  if (body === undefined) throw new Error(`Object ${key} has no body.`);
  return body;
}

/** Like getObject, without decoding: for objects that may not be text. */
export async function getObjectBytes(bucket: Bucket, key: string): Promise<Buffer> {
  const result = await storage().send(new GetObjectCommand({ Bucket: bucketName(bucket), Key: key }));
  const body = await result.Body?.transformToByteArray();
  if (body === undefined) throw new Error(`Object ${key} has no body.`);
  return Buffer.from(body);
}

/** Deleting an object that isn't there succeeds, the way S3 defines it. */
export async function deleteObject(bucket: Bucket, key: string): Promise<void> {
  await storage().send(new DeleteObjectCommand({ Bucket: bucketName(bucket), Key: key }));
}

export async function closeStorage(): Promise<void> {
  client?.destroy();
  client = null;
}
