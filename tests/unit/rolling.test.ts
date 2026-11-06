import { describe, expect, it } from "vitest";
import { rollingPass } from "@/lib/worker/rolling";

/** A queue of `total` items that each take `ms`, recording the most in flight at once. */
function queue(total: number, ms: number) {
  let remaining = total;
  let inFlight = 0;
  let most = 0;
  let done = 0;
  return {
    claim: async (room: number) => {
      const take = Math.min(room, remaining);
      remaining -= take;
      return Array.from({ length: take }, (_, i) => i);
    },
    work: async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, ms));
      inFlight--;
      done++;
    },
    stats: () => ({ most, done, remaining }),
  };
}

describe("rollingPass", () => {
  it("keeps the limit in flight, refills as slots free and drains", async () => {
    const q = queue(25, 5);
    const result = await rollingPass({ limit: 4, budgetMs: 5_000, claim: q.claim, work: q.work, stopped: () => false });
    expect(result).toEqual({ claimed: 25, backlog: false });
    expect(q.stats()).toMatchObject({ most: 4, done: 25, remaining: 0 });
  });

  it("stops claiming at its budget, finishes what's in flight and reports the backlog", async () => {
    const q = queue(1_000, 20);
    const result = await rollingPass({ limit: 5, budgetMs: 60, claim: q.claim, work: q.work, stopped: () => false });
    expect(result.backlog).toBe(true);
    expect(q.stats().done).toBe(result.claimed);
    expect(q.stats().remaining).toBeGreaterThan(0);
  });

  it("claims nothing once stopped", async () => {
    const q = queue(10, 1);
    expect(await rollingPass({ limit: 3, budgetMs: 1_000, claim: q.claim, work: q.work, stopped: () => true })).toEqual({ claimed: 0, backlog: false });
  });

  it("waits for a slot rather than spinning when nothing new is due", async () => {
    let claims = 0;
    const result = await rollingPass({
      limit: 2,
      budgetMs: 1_000,
      claim: async (room) => (claims++ === 0 ? Array.from({ length: room }, (_, i) => i) : []),
      work: () => new Promise((resolve) => setTimeout(resolve, 30)),
      stopped: () => false,
    });
    expect(result).toEqual({ claimed: 2, backlog: false });
    expect(claims).toBeLessThanOrEqual(3);
  });
});
