import { describe, expect, it } from "vitest";
import { backoffDelayMs, DELIVERY_EXPIRY_MS, nextAttempt } from "@/lib/webhooks/backoff";

describe("backoffDelayMs", () => {
  it("follows the documented schedule: 30s, 2m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, then 6h", () => {
    expect(backoffDelayMs(1)).toBe(30 * 1000);
    expect(backoffDelayMs(2)).toBe(2 * 60 * 1000);
    expect(backoffDelayMs(3)).toBe(5 * 60 * 1000);
    expect(backoffDelayMs(4)).toBe(15 * 60 * 1000);
    expect(backoffDelayMs(5)).toBe(30 * 60 * 1000);
    expect(backoffDelayMs(6)).toBe(60 * 60 * 1000);
    expect(backoffDelayMs(7)).toBe(2 * 60 * 60 * 1000);
    expect(backoffDelayMs(8)).toBe(4 * 60 * 60 * 1000);
    expect(backoffDelayMs(9)).toBe(8 * 60 * 60 * 1000);
    expect(backoffDelayMs(10)).toBe(6 * 60 * 60 * 1000);
    expect(backoffDelayMs(20)).toBe(6 * 60 * 60 * 1000);
  });
});

describe("nextAttempt", () => {
  const created = new Date("2026-01-01T00:00:00.000Z");
  const expiresAt = new Date(created.getTime() + DELIVERY_EXPIRY_MS);

  it("is not exhausted while the next attempt lands before the 24-hour expiry", () => {
    expect(nextAttempt(1, created, expiresAt).exhausted).toBe(false);
    expect(nextAttempt(9, created, expiresAt).exhausted).toBe(false);
  });

  it("exhausts once the next scheduled attempt would land at or past expires_at", () => {
    // One steady-state (6h) attempt short of 24h, from a point already close to expiry.
    const almostExpired = new Date(expiresAt.getTime() - 5 * 60 * 60 * 1000);
    expect(nextAttempt(10, almostExpired, expiresAt).exhausted).toBe(true);
  });

  it("is exhausted exactly at expires_at", () => {
    expect(nextAttempt(10, expiresAt, expiresAt).exhausted).toBe(true);
  });
});
