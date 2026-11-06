import { afterEach, describe, expect, it } from "vitest";
import { assetsBaseUrl, assetsBucket, assetUrl, putObject } from "@/lib/storage";

const originalBucket = process.env.STORAGE_ASSETS_BUCKET;
const originalBaseUrl = process.env.STORAGE_ASSETS_BASE_URL;

afterEach(() => {
  if (originalBucket === undefined) delete process.env.STORAGE_ASSETS_BUCKET;
  else process.env.STORAGE_ASSETS_BUCKET = originalBucket;
  if (originalBaseUrl === undefined) delete process.env.STORAGE_ASSETS_BASE_URL;
  else process.env.STORAGE_ASSETS_BASE_URL = originalBaseUrl;
});

describe("assets bucket, unconfigured", () => {
  it("degrades to null instead of throwing", () => {
    delete process.env.STORAGE_ASSETS_BUCKET;
    delete process.env.STORAGE_ASSETS_BASE_URL;

    expect(assetsBucket()).toBeNull();
    expect(assetsBaseUrl()).toBeNull();
    expect(assetUrl("logo.png")).toBeNull();
  });

  it("still treats the base URL as unset when only the bucket is configured", () => {
    process.env.STORAGE_ASSETS_BUCKET = "pouch-static";
    delete process.env.STORAGE_ASSETS_BASE_URL;

    expect(assetsBaseUrl()).toBeNull();
    expect(assetUrl("logo.png")).toBeNull();
  });

  it("rejects a write to the assets bucket rather than silently falling back to the private one", async () => {
    delete process.env.STORAGE_ASSETS_BUCKET;

    await expect(putObject("assets", "logo.png", "x", "image/png")).rejects.toThrow(
      "STORAGE_ASSETS_BUCKET isn't set.",
    );
  });
});

describe("assets bucket, configured", () => {
  it("builds a public URL under the configured base, with no trailing slash duplication", () => {
    process.env.STORAGE_ASSETS_BUCKET = "pouch-static";
    process.env.STORAGE_ASSETS_BASE_URL = "https://static.pouch.email/";

    expect(assetUrl("logos/abc.png")).toBe("https://static.pouch.email/logos/abc.png");
  });
});
