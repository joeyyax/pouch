/**
 * The link in a digest's `List-Unsubscribe` header. Signed rather than stored: a token encodes
 * the user and the cadence it turns off, so redeeming it needs no lookup table and no expiry to
 * manage — the same HMAC idiom as `lib/webhooks/sign.ts`, keyed by `BETTER_AUTH_SECRET` since
 * this never leaves the app the way a webhook signature does.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { digestPreferences, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { baseUrl } from "@/lib/api/urls";
import type { DigestCadence } from "./cadence";

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET isn't set.");
  return value;
}

function digest(userId: string, cadence: DigestCadence): string {
  return createHmac("sha256", secret()).update(`${userId}.${cadence}`).digest("base64url");
}

/** `<userId>.<cadence>.<signature>`, base64url throughout so it drops straight into a URL. */
export function signUnsubscribeToken(userId: string, cadence: DigestCadence): string {
  const userPart = Buffer.from(userId, "utf8").toString("base64url");
  return `${userPart}.${cadence}.${digest(userId, cadence)}`;
}

export interface UnsubscribeTarget {
  userId: string;
  cadence: DigestCadence;
}

/** Verifies a token and returns what it names, or null when it's malformed or forged. */
export function verifyUnsubscribeToken(token: string): UnsubscribeTarget | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userPart, cadencePart, signature] = parts;
  if (!userPart || !cadencePart || !signature) return null;
  if (cadencePart !== "daily" && cadencePart !== "weekly" && cadencePart !== "monthly") return null;

  let userId: string;
  try {
    userId = Buffer.from(userPart, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!userId) return null;

  const expected = Buffer.from(digest(userId, cadencePart), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  return { userId, cadence: cadencePart };
}

/** The link a digest's `List-Unsubscribe` header points to for one recipient and cadence. */
export function unsubscribeUrl(userId: string, cadence: DigestCadence): string {
  return `${baseUrl()}/unsubscribe/digest/${signUnsubscribeToken(userId, cadence)}`;
}

export interface UnsubscribeResult {
  cadence: DigestCadence;
  email: string;
}

/** Thrown when a token doesn't verify — forged, truncated, or signed under a rotated secret. */
export class InvalidUnsubscribeTokenError extends Error {
  constructor() {
    super("This unsubscribe link is invalid or has expired.");
    this.name = "InvalidUnsubscribeTokenError";
  }
}

/** What a digest link names, read without redeeming it: the account and whether that cadence is still on. Null when it doesn't verify. */
export async function readUnsubscribeToken(token: string): Promise<(UnsubscribeResult & { on: boolean }) | null> {
  const target = verifyUnsubscribeToken(token);
  if (!target) return null;
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, target.userId)).limit(1);
  if (!user) return null;
  const [prefs] = await db.select().from(digestPreferences).where(eq(digestPreferences.userId, target.userId)).limit(1);
  const on = prefs ? prefs[target.cadence] : target.cadence === "weekly";
  return { cadence: target.cadence, email: user.email, on };
}

/**
 * Turns one cadence off for the user a token names. Idempotent — redeeming the same link twice
 * (a mail client's link scanner following it before the person does, a retried POST) just finds
 * the cadence already off.
 */
export async function redeemUnsubscribeToken(token: string): Promise<UnsubscribeResult> {
  const target = verifyUnsubscribeToken(token);
  if (!target) throw new InvalidUnsubscribeTokenError();

  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, target.userId)).limit(1);
  if (!user) throw new InvalidUnsubscribeTokenError();

  const existing = await db
    .select({ id: digestPreferences.id })
    .from(digestPreferences)
    .where(eq(digestPreferences.userId, target.userId))
    .limit(1);

  if (existing[0]) {
    await db
      .update(digestPreferences)
      .set({ [target.cadence]: false, updatedAt: new Date() })
      .where(eq(digestPreferences.userId, target.userId));
  } else {
    // Same defaults as a missing row anywhere else — weekly on, daily and monthly off — with
    // the redeemed cadence forced off regardless of where it started.
    await db.insert(digestPreferences).values({
      id: newId("digestPreferences"),
      userId: target.userId,
      daily: false,
      weekly: target.cadence !== "weekly",
      monthly: false,
    });
  }

  return { cadence: target.cadence, email: user.email };
}
