import { randomBytes } from "node:crypto";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteObject, getObject, putObject, storage } from "@/lib/storage";
import { newStorageKey, writeBody } from "@/lib/storage/bodies";
import { newMessageKey } from "@/lib/crypto";

/**
 * Real MinIO, not a mock: the point of this suite is that the private and public buckets
 * are actually two buckets, not one bucket with a naming convention.
 */
const TEST_ASSETS_BUCKET = "mail-assets-test";

let previousAssetsBucket: string | undefined;
let previousAssetsBaseUrl: string | undefined;

beforeAll(async () => {
  previousAssetsBucket = process.env.STORAGE_ASSETS_BUCKET;
  previousAssetsBaseUrl = process.env.STORAGE_ASSETS_BASE_URL;
  process.env.STORAGE_ASSETS_BUCKET = TEST_ASSETS_BUCKET;
  process.env.STORAGE_ASSETS_BASE_URL = "https://static.pouch.test";

  try {
    await storage().send(new CreateBucketCommand({ Bucket: TEST_ASSETS_BUCKET }));
  } catch (err) {
    const code = (err as { name?: string })?.name;
    if (code !== "BucketAlreadyOwnedByYou" && code !== "BucketAlreadyExists") throw err;
  }
});

afterAll(() => {
  if (previousAssetsBucket === undefined) delete process.env.STORAGE_ASSETS_BUCKET;
  else process.env.STORAGE_ASSETS_BUCKET = previousAssetsBucket;
  if (previousAssetsBaseUrl === undefined) delete process.env.STORAGE_ASSETS_BASE_URL;
  else process.env.STORAGE_ASSETS_BASE_URL = previousAssetsBaseUrl;
});

function key(): string {
  return `test-assets/${randomBytes(8).toString("hex")}`;
}

describe("the private and public buckets are separate", () => {
  it("puts an asset in the assets bucket, not in the private one", async () => {
    const assetKey = key();
    await putObject("assets", assetKey, "logo-bytes", "image/png");

    await expect(getObject("assets", assetKey)).resolves.toBe("logo-bytes");
    // Same key, other bucket: nothing there. Proves an asset write isn't reachable
    // through the credentialed body store.
    await expect(getObject("private", assetKey)).rejects.toThrow();

    await deleteObject("assets", assetKey);
  });

  it("stores a body only in the private bucket, never in the assets bucket", async () => {
    const storageKey = newStorageKey();
    const { key: messageKey } = newMessageKey();
    await writeBody(messageKey, storageKey, { html: "<p>hi</p>", text: "hi", textGenerated: false, attachments: [] });

    const bodyObjectKey = `${storageKey}/body.json`;
    await expect(getObject("private", bodyObjectKey)).resolves.toEqual(expect.any(String));

    // This is the assertion that fails if a body ever gets written to (or is readable
    // from) the public bucket: a mail client fetching by URL must find nothing.
    await expect(getObject("assets", bodyObjectKey)).rejects.toThrow();

    await deleteObject("private", bodyObjectKey);
  });
});
