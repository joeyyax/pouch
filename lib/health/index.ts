import { redis, scanKeys } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

export * from "./jobs";

const log = logger.child("health");

/**
 * One key per worker, so `docker compose up --scale mail-worker=3` shows as three heartbeats
 * instead of one worker overwriting the others' liveness. Each key expires on its own, so a
 * killed worker drops out without anything having to notice and clean it up.
 */
export const HEARTBEAT_KEY_PREFIX = "worker:heartbeat:";
export const HEARTBEAT_TTL_SECONDS = 60;

export interface WorkerHeartbeat {
  workerId: string;
  /** ISO 8601, UTC. */
  at: string;
}

function heartbeatKey(workerId: string): string {
  return `${HEARTBEAT_KEY_PREFIX}${workerId}`;
}

/** Never throws: a worker that can't say it's alive should keep sending. */
export async function recordHeartbeat(workerId: string): Promise<void> {
  const client = redis();
  if (!client) return;
  const beat: WorkerHeartbeat = { workerId, at: new Date().toISOString() };
  try {
    await client.set(heartbeatKey(workerId), JSON.stringify(beat), "EX", HEARTBEAT_TTL_SECONDS);
  } catch (err) {
    log.warn(`heartbeat failed: ${safeErrorMessage(err)}`);
  }
}

/**
 * Every worker that has reported inside the TTL window, newest first. Empty when none has, or
 * Redis can't be reached — the key's own expiry does most of the pruning, but a beat is
 * double-checked against the window here too, since a test (or a clock oddity) can leave a
 * key behind without its TTL.
 */
export async function readHeartbeats(): Promise<WorkerHeartbeat[]> {
  const client = redis();
  if (!client) return [];
  try {
    const keys = await scanKeys(client, HEARTBEAT_KEY_PREFIX);
    if (keys.length === 0) return [];

    const raw = await client.mget(...keys);
    const now = Date.now();
    return raw
      .filter((value): value is string => value !== null)
      .map((value) => JSON.parse(value) as WorkerHeartbeat)
      .filter((beat) => now - new Date(beat.at).getTime() <= HEARTBEAT_TTL_SECONDS * 1000)
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch (err) {
    log.warn(`reading heartbeats failed: ${safeErrorMessage(err)}`);
    return [];
  }
}
