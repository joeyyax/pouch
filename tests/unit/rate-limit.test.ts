import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { assertWithinRateLimit, consumeRateLimit, peekRateLimit, rateLimitHeaders, resetRateLimitMemory } from "@/lib/api/rate-limit";
import { redis } from "@/lib/redis";
vi.mock("@/lib/redis", () => ({ redis: vi.fn() }));

describe("per-key rate limit", () => {
  beforeEach(() => resetRateLimitMemory());

  it("allows exactly the configured number of requests", async () => {
    let last = await consumeRateLimit("key_a", 3);
    for (let i = 0; i < 2; i++) last = await consumeRateLimit("key_a", 3);

    expect(last.remaining).toBe(0);
    expect(last.exceeded).toBe(false);
    expect(() => assertWithinRateLimit(last)).not.toThrow();
  });

  it("rejects the request past the limit", async () => {
    for (let i = 0; i < 3; i++) await consumeRateLimit("key_b", 3);
    const over = await consumeRateLimit("key_b", 3);

    expect(over.exceeded).toBe(true);
    expect(() => assertWithinRateLimit(over)).toThrow(ApiError);
  });

  it("counts each key separately", async () => {
    for (let i = 0; i < 3; i++) await consumeRateLimit("key_c", 3);
    const other = await consumeRateLimit("key_d", 3);

    expect(other.remaining).toBe(2);
  });

  it("attaches Retry-After and the limit headers to the rejection", async () => {
    for (let i = 0; i < 2; i++) await consumeRateLimit("key_e", 1);
    const over = await consumeRateLimit("key_e", 1);

    try {
      assertWithinRateLimit(over);
      throw new Error("expected a rate limit error");
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.code).toBe("rate_limit_exceeded");
      expect(Number(apiError.headers["Retry-After"])).toBeGreaterThan(0);
      expect(apiError.headers["X-RateLimit-Remaining"]).toBe("0");
    }
  });

  it("reports the reset as unix seconds", async () => {
    const result = await consumeRateLimit("key_f", 10);
    const headers = rateLimitHeaders(result);

    expect(Number(headers["X-RateLimit-Reset"])).toBeCloseTo(Math.ceil(result.resetAt / 1000), 0);
    expect(headers["X-RateLimit-Limit"]).toBe("10");
  });
});

describe("per-key rate limit with a failing Redis client", () => {
  beforeEach(() => resetRateLimitMemory());

  it("falls back to the in-memory counter when the script errors and still enforces the limit", async () => {
    vi.mocked(redis).mockReturnValue({ eval: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) } as never);

    let last = await consumeRateLimit("key_g", 3);
    for (let i = 0; i < 2; i++) last = await consumeRateLimit("key_g", 3);

    expect(last.remaining).toBe(0);
    expect(last.exceeded).toBe(false);
    const over = await consumeRateLimit("key_g", 3);
    expect(over.exceeded).toBe(true);
    expect(() => assertWithinRateLimit(over)).toThrow(ApiError);
  });

  it("falls back to the in-memory counter when the script returns a malformed reply", async () => {
    // A well-formed reply is a two-element array. This one is missing `previous` entirely -
    // naive destructuring would accept it and poison the count with NaN instead of throwing.
    vi.mocked(redis).mockReturnValue({ eval: vi.fn(async () => [7]) } as never);

    let last = await consumeRateLimit("key_m", 3);
    for (let i = 0; i < 2; i++) last = await consumeRateLimit("key_m", 3);

    expect(last.remaining).toBe(0);
    expect(last.exceeded).toBe(false);
    const over = await consumeRateLimit("key_m", 3);
    expect(over.exceeded).toBe(true);
    expect(() => assertWithinRateLimit(over)).toThrow(ApiError);
  });
});

describe("a key with no allowance", () => {
  beforeEach(() => resetRateLimitMemory());

  it("blocks every request and reports a long, fixed backoff instead of a manufactured countdown", async () => {
    const first = await consumeRateLimit("key_zero", 0);
    const second = await consumeRateLimit("key_zero", 0);

    expect(first.exceeded).toBe(true);
    expect(first.remaining).toBe(0);
    expect(() => assertWithinRateLimit(first)).toThrow(ApiError);

    // Truthful means honest about "not soon", not a countdown that implies the block lifts on
    // its own: a limit of zero can never decay to a satisfiable target.
    expect(first.retryAfterMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
    // Deterministic: it doesn't count down request to request the way a real window would.
    expect(second.retryAfterMs).toBe(first.retryAfterMs);
  });
});

describe("rate limit sliding across a wall-clock minute boundary", () => {
  beforeEach(() => {
    resetRateLimitMemory();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps counting a burst spent just before the boundary once the clock ticks into the next minute", async () => {
    vi.setSystemTime(59_900);
    for (let i = 0; i < 3; i++) await consumeRateLimit("key_h", 3);

    vi.setSystemTime(60_100);
    const justAfter = await consumeRateLimit("key_h", 3);

    expect(justAfter.exceeded).toBe(true);
    expect(() => assertWithinRateLimit(justAfter)).toThrow(ApiError);
  });

  it("would have allowed a second full burst under a fixed window, and must not", async () => {
    vi.setSystemTime(59_950);
    for (let i = 0; i < 5; i++) await consumeRateLimit("key_i", 5);

    // A fixed window keyed on Math.floor(now / WINDOW_MS) resets to an empty bucket here,
    // since 60_050 falls in the next whole minute. A sliding window must not.
    vi.setSystemTime(60_050);
    for (let i = 0; i < 5; i++) {
      const result = await consumeRateLimit("key_i", 5);
      expect(result.exceeded).toBe(true);
    }
  });

  it("never admits more than the limit within a true 60-second window for a client that always waits out its Retry-After", async () => {
    const limit = 10;
    let now = 59_900;
    vi.setSystemTime(now);
    const admittedAt: number[] = [];

    for (let i = 0; i < 40; i++) {
      const result = await consumeRateLimit("key_j", limit);
      if (!result.exceeded) {
        admittedAt.push(now);
        continue;
      }
      now += Math.max(1, result.retryAfterMs);
      vi.setSystemTime(now);
    }

    for (const t of admittedAt) {
      const admittedInTrailingWindow = admittedAt.filter((other) => other > t - 60_000 && other <= t).length;
      expect(admittedInTrailingWindow).toBeLessThanOrEqual(limit);
    }
  });
});
describe("peekRateLimit", () => {
  beforeEach(() => resetRateLimitMemory());

  it("reports a fresh bucket without counting against it", async () => {
    const peeked = await peekRateLimit("peek_a", 3);
    expect(peeked.remaining).toBe(3);

    const consumed = await consumeRateLimit("peek_a", 3);
    expect(consumed.remaining).toBe(2);
  });

  it("sees what consume has counted", async () => {
    for (let i = 0; i < 2; i++) await consumeRateLimit("peek_b", 3);
    expect((await peekRateLimit("peek_b", 3)).remaining).toBe(1);
  });

  it("stays clear of the limit no matter how often it's read", async () => {
    for (let i = 0; i < 10; i++) await peekRateLimit("peek_c", 1);
    expect((await peekRateLimit("peek_c", 1)).exceeded).toBe(false);
  });

  it("exceeds once consume has gone past the limit", async () => {
    for (let i = 0; i < 4; i++) await consumeRateLimit("peek_d", 3);
    expect((await peekRateLimit("peek_d", 3)).exceeded).toBe(true);
  });
});

describe("assertWithinRateLimit", () => {
  it("names the key by default and the subject when given one", async () => {
    resetRateLimitMemory();
    for (let i = 0; i < 2; i++) await consumeRateLimit("subject_a", 1);
    const over = await consumeRateLimit("subject_a", 1);

    expect(() => assertWithinRateLimit(over)).toThrow(/for this key/);
    expect(() => assertWithinRateLimit(over, "this address")).toThrow(/for this address/);
  });
});
