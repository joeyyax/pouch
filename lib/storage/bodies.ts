import { randomBytes } from "node:crypto";
import { decryptBytesWith, encryptWith } from "@/lib/crypto";
import { deleteObject, getObject, putObject } from "./index";
import type { OutboundAttachment } from "@/lib/providers/adapters/types";

export interface StoredBody {
  html: string | null;
  text: string | null;
  /** True when text was derived from html because the caller sent no text of their own. */
  textGenerated: boolean;
  attachments: OutboundAttachment[];
}

/**
 * The root prefix new keys are written under. Fixed at `bodies` in production, so the
 * bucket's lifecycle rule can run on it; overridden by the test suite (`STORAGE_KEY_PREFIX`)
 * so concurrent checkouts and processes sharing one bucket don't see each other's objects.
 */
export function bodiesRoot(): string {
  return process.env.STORAGE_KEY_PREFIX ?? "bodies";
}

/**
 * An opaque prefix for one message's object. Nothing in the key names the org,
 * the message, or the day — so a leaked listing doesn't tie rows to recipients.
 */
export function newStorageKey(): string {
  return `${bodiesRoot()}/${randomBytes(16).toString("base64url")}`;
}

/** Encrypts `plaintext` with a message's key and writes it to `objectKey` in the private bucket. */
export async function writeSealed(key: Buffer, objectKey: string, plaintext: string | Buffer, contentType = "application/octet-stream"): Promise<void> {
  await putObject("private", objectKey, encryptWith(key, plaintext), contentType);
}

/** Reads and decrypts an object written by writeSealed. */
export async function readSealed(key: Buffer, objectKey: string): Promise<Buffer> {
  return decryptBytesWith(key, await getObject("private", objectKey));
}

/** Encrypts and writes the body. The key carries forward to readBody on the same row. */
export async function writeBody(key: Buffer, storageKey: string, body: StoredBody): Promise<void> {
  await writeSealed(key, `${storageKey}/body.json`, JSON.stringify(body), "application/json");
}

/** Removes a written body no row will ever point at. */
export async function purgeBody(storageKey: string): Promise<void> {
  await deleteObject("private", `${storageKey}/body.json`);
}

export async function readBody(key: Buffer, storageKey: string): Promise<StoredBody> {
  return JSON.parse((await readSealed(key, `${storageKey}/body.json`)).toString("utf8")) as StoredBody;
}