import { inject } from "vitest";
import { redis, scanKeys } from "@/lib/redis";
import { checkoutTag, workerId } from "./database-url";

declare module "vitest" {
  export interface ProvidedContext {
    redisUrl: string;
  }
}

/** This checkout and worker's slice of the shared Redis, set as `REDIS_KEY_PREFIX` by `setup.ts`. */
export function testRedisKeyPrefix(): string {
  return `test:${checkoutTag()}:w${workerId()}:`;
}

/** `REDIS_URL` as the run started, before `setup.ts` removes it. */
export function testRedisUrl(): string {
  return inject("redisUrl");
}

/** Deletes this checkout's keys under each prefix. */
export async function clearRedisKeys(...prefixes: string[]): Promise<void> {
  const client = redis();
  if (!client) return;
  const keys = (await Promise.all(prefixes.map((prefix) => scanKeys(client, prefix)))).flat();
  if (keys.length > 0) await client.del(...keys);
}
