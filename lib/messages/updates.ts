import type { MessageStatus } from "@/lib/db/schema";
import { redis, redisChannel } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("updates");

/** One channel per organization, so a subscriber only ever sees its own rows. */
export function updatesChannel(organizationId: string): string {
  return redisChannel(`messages:updates:${organizationId}`);
}

export interface MessageUpdate {
  messageId: string;
  status: MessageStatus;
}

/**
 * Announces that a message moved, for whoever is watching the list. Never throws and never
 * blocks the write it follows: the message changed whether or not anyone was told.
 */
export async function publishMessageUpdate(
  organizationId: string | null,
  update: MessageUpdate,
): Promise<void> {
  // The service's own mail has no organization watching it.
  if (organizationId === null) return;
  const client = redis();
  if (!client) return;
  try {
    await client.publish(updatesChannel(organizationId), JSON.stringify(update));
  } catch (err) {
    log.warn(`publish failed: ${safeErrorMessage(err)}`);
  }
}
