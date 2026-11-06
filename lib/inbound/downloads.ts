/** Expiring bearer links to an inbound attachment or raw message, served decrypted by app/download. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { baseUrl } from "@/lib/api/urls";
import { db } from "@/lib/db";
import { inboundMessages } from "@/lib/db/schema";
import { readInboundObject } from "./attachments";

/** An attachment's index, or the raw message. */
export type InboundPart = number | "raw";

export interface InboundDownload {
  inboundId: string;
  part: InboundPart;
}

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET isn't set.");
  return value;
}

function digest(material: string): string {
  return createHmac("sha256", secret()).update(`inbound-download.${material}`).digest("base64url");
}

/** `<inbound id>.<part>.<expiry, unix seconds>.<signature>`. */
export function signInboundDownload(inboundId: string, part: InboundPart, expiresAt: Date): string {
  const material = `${inboundId}.${part}.${Math.floor(expiresAt.getTime() / 1000)}`;
  return `${material}.${digest(material)}`;
}

/** What a token names, or null when it's malformed, forged or expired. */
export function verifyInboundDownload(token: string, now = new Date()): InboundDownload | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [inboundId, part, expiry, signature] = parts as [string, string, string, string];

  const expected = Buffer.from(digest(`${inboundId}.${part}.${expiry}`), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  if (!/^\d+$/.test(expiry) || Number(expiry) * 1000 <= now.getTime()) return null;
  if (part === "raw") return { inboundId, part };
  if (!/^\d+$/.test(part)) return null;
  return { inboundId, part: Number(part) };
}

export function inboundDownloadUrl(inboundId: string, part: InboundPart, ttlSeconds: number, now = new Date()): string {
  return `${baseUrl()}/download/${signInboundDownload(inboundId, part, new Date(now.getTime() + ttlSeconds * 1000))}`;
}

export interface OpenedInboundDownload {
  content: Buffer;
  filename: string;
  contentType: string;
}

/** The decrypted object a token names, or null when the token or what it names isn't valid anymore. */
export async function openInboundDownload(token: string): Promise<OpenedInboundDownload | null> {
  const target = verifyInboundDownload(token);
  if (!target) return null;
  const [row] = await db.select().from(inboundMessages).where(eq(inboundMessages.id, target.inboundId)).limit(1);
  if (!row) return null;

  if (target.part === "raw") {
    if (!row.rawStorageKey) return null;
    return { content: await readInboundObject(row, row.rawStorageKey), filename: `${row.id}.eml`, contentType: "message/rfc822" };
  }
  const attachment = row.attachments[target.part];
  if (!attachment?.storageKey) return null;
  return { content: await readInboundObject(row, attachment.storageKey), filename: attachment.filename, contentType: attachment.contentType };
}
