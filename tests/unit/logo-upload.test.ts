import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { at } from "../at";

const putObject = vi.fn();
const deleteObject = vi.fn();

vi.mock("@/lib/storage", () => ({
  putObject: (...args: unknown[]) => putObject(...args),
  deleteObject: (...args: unknown[]) => deleteObject(...args),
  assetsBaseUrl: () => "https://static.pouch.test",
  assetUrl: (key: string) => `https://static.pouch.test/${key}`,
}));

const { uploadDomainLogo, deleteUploadedLogoIfOurs, MAX_LOGO_BYTES } = await import("@/lib/domains/logo-upload");

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBytes(size = 32): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(PNG_SIGNATURE, 0);
  // IHDR chunk type at bytes 12-15, the only other thing isPng checks.
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  return bytes;
}

beforeEach(() => {
  putObject.mockReset();
  deleteObject.mockReset();
});

describe("uploadDomainLogo", () => {
  it("stores a valid PNG under the domain's own prefix and returns its public URL", async () => {
    const url = await uploadDomainLogo("dom_1", pngBytes());
    expect(putObject).toHaveBeenCalledTimes(1);
    const [bucket, key, , contentType] = at(putObject.mock.calls, 0);
    expect(bucket).toBe("assets");
    expect(key).toMatch(/^logos\/dom_1\//);
    expect(contentType).toBe("image/png");
    expect(url).toBe(`https://static.pouch.test/${key}`);
  });

  it("rejects bytes that don't start with the PNG signature, regardless of what the caller claims", async () => {
    const notPng = new TextEncoder().encode("<svg></svg>");
    await expect(uploadDomainLogo("dom_1", notPng)).rejects.toMatchObject({ field: "logo" });
    expect(putObject).not.toHaveBeenCalled();
  });

  it("rejects a PNG signature with no IHDR chunk following it", async () => {
    const bytes = new Uint8Array(32);
    bytes.set(PNG_SIGNATURE, 0);
    // Leaves bytes 12-15 zeroed, so it's not "IHDR".
    await expect(uploadDomainLogo("dom_1", bytes)).rejects.toBeInstanceOf(ApiError);
    expect(putObject).not.toHaveBeenCalled();
  });

  it("rejects an oversized file before it ever reaches storage", async () => {
    const oversized = pngBytes(MAX_LOGO_BYTES + 1);
    await expect(uploadDomainLogo("dom_1", oversized)).rejects.toMatchObject({ field: "logo" });
    expect(putObject).not.toHaveBeenCalled();
  });

  it("rejects an empty file", async () => {
    await expect(uploadDomainLogo("dom_1", new Uint8Array(0))).rejects.toBeInstanceOf(ApiError);
  });
});

describe("deleteUploadedLogoIfOurs", () => {
  it("deletes a URL under this domain's uploaded-logo prefix", async () => {
    await deleteUploadedLogoIfOurs("dom_1", "https://static.pouch.test/logos/dom_1/abc.png");
    expect(deleteObject).toHaveBeenCalledWith("assets", "logos/dom_1/abc.png");
  });

  it("leaves an externally hosted URL alone", async () => {
    await deleteUploadedLogoIfOurs("dom_1", "https://example.com/mark.png");
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("leaves another domain's uploaded logo alone", async () => {
    await deleteUploadedLogoIfOurs("dom_1", "https://static.pouch.test/logos/dom_2/abc.png");
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("does nothing for null", async () => {
    await deleteUploadedLogoIfOurs("dom_1", null);
    expect(deleteObject).not.toHaveBeenCalled();
  });
});
