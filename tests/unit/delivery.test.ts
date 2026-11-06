import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, MAX_QUEUE_AGE_MS, decideDelivery, retryDelayMs } from "@/lib/messages/delivery";
import type { Receipt } from "@/lib/providers/adapters/types";

const success: Receipt = { successful: true, providerMessageId: "abc123" };

describe("decideDelivery", () => {
  it("marks a successful receipt as sent and carries the provider id", () => {
    expect(decideDelivery(success, 1)).toEqual({ kind: "sent", status: "sent", providerMessageId: "abc123" });
  });

  it("fails a permanent rejection on the first attempt", () => {
    const action = decideDelivery(
      { successful: false, errors: ["to: is invalid"], failure: "permanent" },
      1,
    );
    expect(action).toMatchObject({ kind: "failed", status: "failed", reason: "to: is invalid" });
  });

  it("retries a transient rejection while attempts remain", () => {
    const action = decideDelivery({ successful: false, errors: ["HTTP 502"], failure: "transient" }, 1);
    expect(action.kind).toBe("retry");
  });

  it("fails a transient rejection once attempts run out", () => {
    const action = decideDelivery(
      { successful: false, errors: ["HTTP 502"], failure: "transient" },
      MAX_ATTEMPTS,
    );
    expect(action.kind).toBe("failed");
  });

  it("says whether a backoff holds every tenant of a shared provider", () => {
    const wide = decideDelivery({ successful: false, errors: ["throttled"], failure: "backoff", accountWide: true }, 1);
    const own = decideDelivery({ successful: false, errors: ["paused"], failure: "backoff" }, 1);
    expect(wide).toMatchObject({ kind: "backoff", accountWide: true });
    expect(own).toMatchObject({ kind: "backoff", accountWide: false });
  });

  it("treats a backoff receipt as a provider pause, not a message failure", () => {
    const action = decideDelivery(
      { successful: false, errors: ["You are sending emails too quickly"], failure: "backoff", retryAfterSeconds: 30 },
      1,
    );
    expect(action).toMatchObject({ kind: "backoff", backoffMs: 30_000 });
  });

  it("backs off even on the last attempt, so a rate limit never fails a message", () => {
    const action = decideDelivery(
      { successful: false, errors: ["rate limited"], failure: "backoff" },
      MAX_ATTEMPTS + 3,
    );
    expect(action.kind).toBe("backoff");
  });

  it("fails a message that has been queued past the age cap, even on backoff", () => {
    const action = decideDelivery(
      { successful: false, errors: ["rate limited"], failure: "backoff" },
      1,
      Math.random,
      MAX_QUEUE_AGE_MS,
    );
    expect(action.kind).toBe("failed");
  });

  it("still backs off inside the age cap", () => {
    const action = decideDelivery(
      { successful: false, errors: ["rate limited"], failure: "backoff" },
      1,
      Math.random,
      MAX_QUEUE_AGE_MS - 1000,
    );
    expect(action.kind).toBe("backoff");
  });

  it("joins several provider reasons into one string", () => {
    const action = decideDelivery(
      { successful: false, errors: ["to: is invalid", "from: not parseable"], failure: "permanent" },
      1,
    );
    expect(action).toMatchObject({ reason: "to: is invalid; from: not parseable" });
  });
});

describe("retryDelayMs", () => {
  it("never returns less than the base delay", () => {
    expect(retryDelayMs(1, () => 0)).toBe(15_000);
  });

  it("widens the jitter ceiling as attempts climb", () => {
    expect(retryDelayMs(4, () => 1)).toBeGreaterThan(retryDelayMs(2, () => 1));
  });

  it("caps the ceiling at 30 minutes", () => {
    expect(retryDelayMs(50, () => 1)).toBe(30 * 60 * 1000);
  });
});
