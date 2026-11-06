import Redis from "ioredis";
import { logger } from "./logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("redis");

let client: Redis | null = null;

/** Prepended to every key and channel. Unset in production; the test suite sets it per checkout. */
function keyPrefix(): string {
  return process.env.REDIS_KEY_PREFIX ?? "";
}

/** Returns the shared Redis client, or null when REDIS_URL is unset. */
export function redis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false, keyPrefix: keyPrefix() });
    client.on("error", (err) => log.warn(`connection error: ${safeErrorMessage(err)}`));
  }
  return client;
}

/** ioredis prefixes keys but not pub/sub channels, so every channel name goes through here. */
export function redisChannel(name: string): string {
  return `${keyPrefix()}${name}`;
}

/** Every key starting with `prefix`, returned without the client's key prefix so it can be passed back to commands. */
export async function scanKeys(client: Redis, prefix: string): Promise<string[]> {
  const own = client.options.keyPrefix ?? "";
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await client.scan(cursor, "MATCH", `${own}${prefix}*`, "COUNT", 100);
    cursor = next;
    keys.push(...batch.map((key) => key.slice(own.length)));
  } while (cursor !== "0");
  return keys;
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  await client.quit().catch(() => client?.disconnect());
  client = null;
}
