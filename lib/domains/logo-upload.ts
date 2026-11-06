import { nanoid } from "nanoid";
import { ApiError } from "@/lib/api/errors";
import { assetUrl, assetsBaseUrl, deleteObject, putObject } from "@/lib/storage";

/** A few tens of KB, per the guideline next to the upload control — this is the hard stop. */
export const MAX_LOGO_BYTES = 100 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function keyPrefix(domainId: string): string {
  return `logos/${domainId}/`;
}

/**
 * True only for a well-formed PNG: the 8-byte signature, then an IHDR chunk as the first chunk.
 * Checked against the decoded bytes, not the filename or the browser-supplied content type —
 * either of those can claim anything.
 */
function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 24) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  // Bytes 12–15 of a valid PNG are always the first chunk's type, which is always IHDR.
  return (
    bytes[12] === 0x49 && // I
    bytes[13] === 0x48 && // H
    bytes[14] === 0x44 && // D
    bytes[15] === 0x52 // R
  );
}

/**
 * Validates and stores a logo upload in the public assets bucket, scoped under the domain's own
 * prefix. Returns the public URL to write into `DomainLayout.logoUrl`.
 */
export async function uploadDomainLogo(domainId: string, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength === 0) {
    throw new ApiError("validation_failed", "Logo file is empty.", { field: "logo" });
  }
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    throw new ApiError(
      "validation_failed",
      `Logo is ${Math.ceil(bytes.byteLength / 1024)}KB. Keep it under ${MAX_LOGO_BYTES / 1024}KB.`,
      { field: "logo" },
    );
  }
  if (!isPng(bytes)) {
    throw new ApiError("validation_failed", "Logo must be a PNG.", { field: "logo" });
  }
  if (!assetsBaseUrl()) {
    throw new ApiError(
      "validation_failed",
      "Logo uploads aren't configured for this environment. Paste a hosted URL instead.",
      { field: "logo" },
    );
  }

  const key = `${keyPrefix(domainId)}${nanoid()}.png`;
  await putObject("assets", key, bytes, "image/png");
  const url = assetUrl(key);
  if (!url) {
    throw new ApiError(
      "validation_failed",
      "Logo uploads aren't configured for this environment. Paste a hosted URL instead.",
      { field: "logo" },
    );
  }
  return url;
}

/**
 * Best-effort delete of a previously uploaded logo, when the URL being replaced or cleared is
 * one this domain uploaded — never an externally hosted URL the operator typed in.
 */
export async function deleteUploadedLogoIfOurs(domainId: string, logoUrl: string | null): Promise<void> {
  if (!logoUrl) return;
  const base = assetsBaseUrl();
  if (!base) return;
  const prefix = `${base.replace(/\/$/, "")}/${keyPrefix(domainId)}`;
  if (!logoUrl.startsWith(prefix)) return;
  const key = logoUrl.slice(base.replace(/\/$/, "").length + 1);
  await deleteObject("assets", key);
}
