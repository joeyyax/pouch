import { randomUUID } from "node:crypto";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { ApiError } from "./errors";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("ratelimit");

export interface RateLimitResult {
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
  exceeded: boolean;
}

const WINDOW_MS = 60_000;
const BUCKET_TTL_MS = WINDOW_MS * 2;
// A key with no allowance left never decays to a satisfiable target. Callers get a long,
// fixed backoff instead of a manufactured countdown that implies a retry will succeed.
const BLOCKED_KEY_BACKOFF_MS = 24 * 60 * 60 * 1000;

interface WindowCounts {
  current: number;
  previous: number;
}

// Increments the current minute's bucket and reads the prior one in a single round trip.
// The bucket sets its own expiry on creation, so it needs no separate cleanup: it's read as
// "current" for up to one window, then as "previous" for one more, then it's gone.
const SLIDING_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ${BUCKET_TTL_MS})
end
local previous = tonumber(redis.call('GET', KEYS[2]) or '0')
return { current, previous }
`;

/** Keys held in the fallback before the stale ones are swept. Only the Redis-failure path writes here. */
const MEMORY_LIMIT = 5_000;
const memory = new Map<string, { bucket: number; current: number; previous: number }>();

/** Drops keys whose window has rolled past reuse. The key carries a client address, so it's unbounded otherwise. */
function sweepMemory(bucket: number): void {
  for (const [key, record] of memory) if (bucket - record.bucket > 1) memory.delete(key);
}

function countInMemory(keyId: string, bucket: number): WindowCounts {
  const record = memory.get(keyId);
  if (!record || bucket - record.bucket > 1) {
    if (memory.size >= MEMORY_LIMIT) sweepMemory(bucket);
    memory.set(keyId, { bucket, current: 1, previous: 0 });
    return { current: 1, previous: 0 };
  }
  if (record.bucket === bucket) {
    record.current += 1;
    return { current: record.current, previous: record.previous };
  }
  const next = { bucket, current: 1, previous: record.current };
  memory.set(keyId, next);
  return { current: next.current, previous: next.previous };
}

/** The weighted count still active `elapsedMs` into the current bucket. */
function weightedCount(counts: WindowCounts, elapsedMs: number): number {
  return counts.previous * (1 - elapsedMs / WINDOW_MS) + counts.current;
}

/**
 * Milliseconds until a bucket's count no longer counts against `target`, assuming no further
 * requests. Gives no credit for gradual decay: a bucket's full count stays live through the end
 * of the bucket after it, as if every request in it landed at the bucket's last instant.
 */
function msUntilAtMost(counts: WindowCounts, elapsedMs: number, target: number): number {
  const { previous, current } = counts;
  if (previous + current <= target) return 0;

  const remainingInWindow = WINDOW_MS - elapsedMs;
  if (current <= target) return remainingInWindow;
  return remainingInWindow + WINDOW_MS;
}

/** Validates the `{ current, previous }` shape returned by `SLIDING_WINDOW_SCRIPT`. */
function parseSlidingWindowReply(reply: unknown): WindowCounts {
  if (!Array.isArray(reply) || reply.length !== 2) throw new Error("malformed sliding window reply");
  const [current, previous] = reply as [unknown, unknown];
  if (typeof current !== "number" || typeof previous !== "number" || !Number.isFinite(current) || !Number.isFinite(previous)) {
    throw new Error("malformed sliding window reply");
  }
  return { current, previous };
}

function buildResult(limit: number, counts: WindowCounts, elapsedMs: number): RateLimitResult {
  const weighted = weightedCount(counts, elapsedMs);
  return {
    limit,
    remaining: Math.max(0, Math.floor(limit - weighted)),
    resetAt: Date.now() + msUntilAtMost(counts, elapsedMs, 0),
    retryAfterMs: msUntilAtMost(counts, elapsedMs, limit - 1),
    exceeded: weighted > limit,
  };
}

function peekInMemory(keyId: string, bucket: number): WindowCounts {
  const record = memory.get(keyId);
  if (!record || bucket - record.bucket > 1) return { current: 0, previous: 0 };
  if (record.bucket === bucket) return { current: record.current, previous: record.previous };
  return { current: 0, previous: record.current };
}

/** Reads a bucket's standing without counting against it. For deciding whether to do the work at all. */
export async function peekRateLimit(keyId: string, limit: number): Promise<RateLimitResult> {
  const now = Date.now();
  const bucket = Math.floor(now / WINDOW_MS);
  const elapsedMs = now - bucket * WINDOW_MS;
  const client = redis();

  let counts: WindowCounts | null = null;
  if (client) {
    try {
      const reply = await client.mget(`ratelimit:${keyId}:${bucket}`, `ratelimit:${keyId}:${bucket - 1}`);
      counts = { current: Number(reply[0] ?? 0), previous: Number(reply[1] ?? 0) };
    } catch (err) {
      log.warn(`rate limit peek fell back to memory: ${safeErrorMessage(err)}`);
      counts = null;
    }
  }
  if (!counts) counts = peekInMemory(keyId, bucket);

  return buildResult(limit, counts, elapsedMs);
}

/** Counts one request against a key's rolling per-minute limit. Redis-backed, with an in-process fallback. */
export async function consumeRateLimit(keyId: string, limit: number): Promise<RateLimitResult> {
  if (limit <= 0) {
    return { limit, remaining: 0, resetAt: Date.now() + BLOCKED_KEY_BACKOFF_MS, retryAfterMs: BLOCKED_KEY_BACKOFF_MS, exceeded: true };
  }

  const now = Date.now();
  const bucket = Math.floor(now / WINDOW_MS);
  const elapsedMs = now - bucket * WINDOW_MS;
  const client = redis();

  let counts: WindowCounts | null = null;

  if (client) {
    try {
      const currentKey = `ratelimit:${keyId}:${bucket}`;
      const previousKey = `ratelimit:${keyId}:${bucket - 1}`;
      const reply = await client.eval(SLIDING_WINDOW_SCRIPT, 2, currentKey, previousKey);
      counts = parseSlidingWindowReply(reply);
    } catch (err) {
      log.warn(`rate limit fell back to memory: ${safeErrorMessage(err)}`);
      counts = null;
    }
  }

  if (!counts) counts = countInMemory(keyId, bucket);

  return buildResult(limit, counts, elapsedMs);
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
  };
}

export function assertWithinRateLimit(result: RateLimitResult, subject = "this key"): void {
  if (!result.exceeded) return;
  const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  throw new ApiError("rate_limit_exceeded", `Rate limit exceeded for ${subject}. Retry after ${retryAfter} seconds.`, {
    headers: { "Retry-After": String(retryAfter), ...rateLimitHeaders(result) },
  });
}

export function resetRateLimitMemory(): void {
  memory.clear();
}

// --- Concurrent streams ---
//
// An open SSE connection isn't a request in the sense the sliding window above counts: it sits
// idle for most of its life, and the thing worth rationing is how many a key holds open at
// once, not how often it opens one. Tracked in a Redis sorted set scored by expiry rather than
// a plain counter, so a connection that crashes without releasing its slot ages out on its own
// within STREAM_SLOT_TTL_MS instead of leaking the slot forever.

const STREAM_KEY_PREFIX = "streams:";
/** Refreshed on every heartbeat; a slot outlives one missed heartbeat but not a dead connection. */
const STREAM_SLOT_TTL_MS = 90_000;

/**
 * Concurrent streams one key may hold open across `/v1/emails/:id/events` and `/v1/events`
 * combined. Ten is enough for a person watching a handful of sends from a terminal or a CI job
 * tailing a batch of test messages, and low enough that one caller can't pin every worker on an
 * indefinitely-held connection — see docs/decisions.md for the full reasoning.
 */
export function maxConcurrentStreams(): number {
  return Number(process.env.MAX_CONCURRENT_STREAMS_PER_KEY ?? "10");
}

// Atomic so two connections racing for the last slot can't both succeed: prune expired members,
// check the count, and reserve in one round trip.
const ACQUIRE_STREAM_SLOT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[2]) then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ${STREAM_SLOT_TTL_MS})
return 1
`;

export interface StreamSlot {
  /** Extends this slot's lease. Call on every heartbeat, or a live connection ages out anyway. */
  refresh(): Promise<void>;
  /** Frees the slot immediately, for a connection that closes on its own rather than crashing. */
  release(): Promise<void>;
}

export type StreamSlotOutcome = { ok: true; slot: StreamSlot } | { ok: false; reason: "unavailable" | "limit" };

/**
 * Reserves one of a key's concurrent-stream slots. `unavailable` when there's no Redis to track
 * it in — a stream endpoint with no Redis has nothing to hold open anyway, the same reasoning
 * the dashboard's live route already follows. `limit` when the key's ceiling is already spent.
 */
export async function acquireStreamSlot(keyId: string, limit: number): Promise<StreamSlotOutcome> {
  const client = redis();
  if (!client) return { ok: false, reason: "unavailable" };

  const setKey = `${STREAM_KEY_PREFIX}${keyId}`;
  const member = randomUUID();
  const now = Date.now();

  try {
    const reserved = await client.eval(ACQUIRE_STREAM_SLOT_SCRIPT, 1, setKey, now, limit, now + STREAM_SLOT_TTL_MS, member);
    if (reserved !== 1) return { ok: false, reason: "limit" };
  } catch (err) {
    log.warn(`stream slot acquisition failed: ${safeErrorMessage(err)}`);
    return { ok: false, reason: "unavailable" };
  }

  return {
    ok: true,
    slot: {
      async refresh() {
        try {
          await client.zadd(setKey, "GT", Date.now() + STREAM_SLOT_TTL_MS, member);
        } catch (err) {
          log.warn(`stream slot refresh failed: ${safeErrorMessage(err)}`);
        }
      },
      async release() {
        try {
          await client.zrem(setKey, member);
        } catch (err) {
          log.warn(`stream slot release failed: ${safeErrorMessage(err)}`);
        }
      },
    },
  };
}

export function assertStreamCapacity(outcome: StreamSlotOutcome): asserts outcome is { ok: true; slot: StreamSlot } {
  if (outcome.ok) return;
  if (outcome.reason === "limit") {
    throw new ApiError("stream_limit_exceeded", "Too many streams open for this key. Close one and reconnect.");
  }
  throw new ApiError("provider_unavailable", "Live streams are off right now. Poll the message instead.");
}
