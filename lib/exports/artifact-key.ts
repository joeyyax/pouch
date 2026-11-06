import { randomBytes } from "node:crypto";

/**
 * Root prefix for a queued export's finished artifact, in the same private bucket message
 * bodies live in. Shares `STORAGE_KEY_PREFIX` with lib/storage/bodies.ts's `bodiesRoot` so a
 * test run's exports are isolated from every other checkout and process sharing the bucket,
 * the same way its bodies are — under its own suffix, so the two never collide on a key.
 */
export function exportsRoot(): string {
  return `${process.env.STORAGE_KEY_PREFIX ?? "bodies"}-exports`;
}

/** An opaque key for one export's artifact — nothing in it names the organization or the export. */
export function newExportObjectKey(): string {
  return `${exportsRoot()}/${randomBytes(16).toString("base64url")}`;
}
