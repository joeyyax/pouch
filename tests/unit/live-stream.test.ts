import { describe, expect, it, vi } from "vitest";
import { within } from "@/app/api/dashboard/messages/route";

/**
 * The route must know the connection and the subscription both took before it answers.
 * Returning the stream first sends the response headers, the browser fires onopen, and the
 * page reports "Live" while nothing is listening — the one failure it must never report as
 * working.
 */
describe("within", () => {
  it("resolves when the work lands", async () => {
    await expect(within(Promise.resolve(1), "subscribe")).resolves.toBeUndefined();
  });

  it("rejects rather than hanging on a Redis that never answers", async () => {
    vi.useFakeTimers();
    try {
      const pending = within(new Promise<never>(() => {}), "subscribe");
      const settled = expect(pending).rejects.toThrow("subscribe timed out");
      await vi.advanceTimersByTimeAsync(5000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a refusal straight through", async () => {
    await expect(within(Promise.reject(new Error("ECONNREFUSED")), "connect")).rejects.toThrow(
      "ECONNREFUSED",
    );
  });
});
