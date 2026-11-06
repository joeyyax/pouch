/** Expiring bearer links to a sent message's attachment, served decrypted by app/download. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { baseUrl } from "@/lib/api/urls";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { retentionDaysFor } from "@/lib/organizations";
import { readBody } from "@/lib/storage/bodies";
import { bodyKeptUntil } from "./retention";

export const MESSAGE_DOWNLOAD_URL_TTL_SECONDS = 900;

export interface MessageDownload {
  messageId: string;
  index: number;
}

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET isn't set.");
  return value;
}

function digest(material: string): string {
  return createHmac("sha256", secret()).update(`message-download.${material}`).digest("base64url");
}

/** `<message id>.<attachment index>.<expiry, unix seconds>.<signature>`. */
export function signMessageDownload(messageId: string, index: number, expiresAt: Date): string {
  const material = `${messageId}.${index}.${Math.floor(expiresAt.getTime() / 1000)}`;
  return `${material}.${digest(material)}`;
}

/** What a token names, or null when it's malformed, forged or expired. */
export function verifyMessageDownload(token: string, now = new Date()): MessageDownload | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [messageId, index, expiry, signature] = parts as [string, string, string, string];

  const expected = Buffer.from(digest(`${messageId}.${index}.${expiry}`), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  if (!/^\d+$/.test(expiry) || Number(expiry) * 1000 <= now.getTime()) return null;
  if (!/^\d+$/.test(index)) return null;
  return { messageId, index: Number(index) };
}

export function messageDownloadUrl(messageId: string, index: number, ttlSeconds: number, now = new Date()): string {
  return `${baseUrl()}/download/${signMessageDownload(messageId, index, new Date(now.getTime() + ttlSeconds * 1000))}`;
}

/** True for a token this module signs rather than an inbound one. */
export function isMessageDownloadToken(token: string): boolean {
  return token.startsWith("msg_");
}

export interface OpenedMessageDownload {
  content: Buffer;
  filename: string;
  contentType: string;
}

/** The decrypted attachment a token names, or null when the token or the body isn't valid anymore. */
export async function openMessageDownload(token: string, now = new Date()): Promise<OpenedMessageDownload | null> {
  const target = verifyMessageDownload(token, now);
  if (!target) return null;
  const [row] = await db.select().from(messages).where(eq(messages.id, target.messageId)).limit(1);
  if (!row?.bodyKey || !row.storageKey || row.bodyPurgedAt || typeof row.bodyWithheld === "string") return null;
  if (bodyKeptUntil(row.createdAt, await retentionDaysFor(row.organizationId)) <= now) return null;

  const body = await readBody(Buffer.from(row.bodyKey, "base64"), row.storageKey);
  const attachment = body.attachments[target.index];
  if (!attachment) return null;
  return { content: Buffer.from(attachment.content, "base64"), filename: attachment.filename, contentType: attachment.contentType };
}
