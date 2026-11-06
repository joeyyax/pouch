import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import type { MessageRow } from "@/lib/db/schema";
import { sha256 } from "@/lib/crypto";
import type { SendEmailRequest } from "@/lib/schemas/email";

export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Hashes the validated request with object keys sorted, so field order doesn't change the result. */
export function hashRequest(request: SendEmailRequest): string {
  return sha256(canonicalize(request));
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
}

/**
 * Finds the message accepted under this key. Not windowed: the unique index isn't either,
 * so a key older than the replay window has to resolve here rather than collide on insert.
 */
export async function findByIdempotencyKey(organizationId: string | null, key: string): Promise<MessageRow | null> {
  const [row] = await db
    .select()
    .from(messages)
    .where(
      and(
        organizationId === null ? isNull(messages.organizationId) : eq(messages.organizationId, organizationId),
        eq(messages.idempotencyKey, key),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** True when the message is old enough that the caller is past the documented replay window. */
export function outsideReplayWindow(message: MessageRow, now: Date): boolean {
  return message.createdAt.getTime() < now.getTime() - IDEMPOTENCY_WINDOW_MS;
}
