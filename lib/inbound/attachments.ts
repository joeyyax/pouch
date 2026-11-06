import { randomBytes } from "node:crypto";
import { deleteObject, getObjectBytes } from "@/lib/storage";
import { readSealed, writeSealed } from "@/lib/storage/bodies";
import type { InboundAttachment, InboundMessageRow } from "@/lib/db/schema";
import type { NormalizedInboundAttachment } from "@/lib/providers/adapters/types";

/** An inbound message's text and HTML. */
export interface InboundBody {
  text: string | null;
  html: string | null;
}

/**
 * The root prefix new inbound attachment keys are written under. Fixed at `inbound` in
 * production; overridden by the test suite (`STORAGE_KEY_PREFIX`) so concurrent checkouts
 * sharing one bucket don't see each other's objects — same convention as lib/storage/bodies.ts.
 */
export function inboundRoot(): string {
  return process.env.STORAGE_KEY_PREFIX ? `${process.env.STORAGE_KEY_PREFIX}-inbound` : "inbound";
}

/** An opaque prefix for one inbound message's objects. Names nothing about its contents. */
export function newInboundStorageKey(): string {
  return `${inboundRoot()}/${randomBytes(16).toString("base64url")}`;
}

export function inboundBodyKey(storageKey: string): string {
  return `${storageKey}/body.json`;
}

/** Seals the text and HTML under `storageKey`. */
export async function writeInboundBody(key: Buffer, storageKey: string, body: InboundBody): Promise<void> {
  await writeSealed(key, inboundBodyKey(storageKey), JSON.stringify({ text: body.text, html: body.html }), "application/json");
}

/**
 * Seals every attachment under `storageKey`, indexed, and returns their stored metadata. A
 * quarantined message keeps the metadata and none of the content.
 */
export async function writeInboundAttachments(
  storageKey: string | null,
  key: Buffer | null,
  attachments: NormalizedInboundAttachment[],
): Promise<InboundAttachment[]> {
  const stored: InboundAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const objectKey = storageKey && key ? `${storageKey}/${index}` : null;
    if (objectKey && key) await writeSealed(key, objectKey, attachment.content);
    stored.push({
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.content.length,
      storageKey: objectKey,
    });
  }
  return stored;
}

/** Seals the message as received next to its attachments and returns its key. */
export async function writeInboundRaw(storageKey: string, key: Buffer, raw: Buffer): Promise<string> {
  const objectKey = `${storageKey}/raw`;
  await writeSealed(key, objectKey, raw);
  return objectKey;
}

type StoredRow = Pick<InboundMessageRow, "bodyKey" | "storageKey" | "text" | "html">;

/** The row's text and HTML: decrypted from storage, or from the columns on a row stored before bodies were sealed. */
export async function readInboundBody(row: StoredRow): Promise<InboundBody> {
  if (!row.bodyKey || !row.storageKey) return { text: row.text, html: row.html };
  const sealed = await readSealed(Buffer.from(row.bodyKey, "base64"), inboundBodyKey(row.storageKey));
  const body = JSON.parse(sealed.toString("utf8")) as InboundBody;
  return { text: body.text ?? null, html: body.html ?? null };
}

/** One attachment or the raw message, decrypted when the row is sealed. */
export async function readInboundObject(row: Pick<InboundMessageRow, "bodyKey">, objectKey: string): Promise<Buffer> {
  if (!row.bodyKey) return getObjectBytes("private", objectKey);
  return readSealed(Buffer.from(row.bodyKey, "base64"), objectKey);
}

/** Removes every object a purged row pointed at. Deleting what's already gone succeeds. */
export async function purgeInboundObjects(row: Pick<InboundMessageRow, "attachments" | "rawStorageKey" | "storageKey">): Promise<void> {
  const keys = [
    ...row.attachments.map((attachment) => attachment.storageKey),
    row.rawStorageKey,
    row.storageKey ? inboundBodyKey(row.storageKey) : null,
  ].filter((key): key is string => key !== null);
  await Promise.all(keys.map((key) => deleteObject("private", key)));
}
