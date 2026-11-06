import { afterEach, describe, expect, it, vi } from "vitest";
import { assertTransition, canTransition, isTerminal, nextStatuses } from "@/lib/messages/lifecycle";
import { deferSignalsToHost, onShutdown, resetLifecycle, runShutdownNow } from "@/lib/lifecycle";

describe("message lifecycle", () => {
  it.each([
    ["queued", "sent", true],
    ["queued", "delivered", false],
    ["deferred", "sent", true],
    ["delivered", "complained", true],
    ["delivered", "bounced", true],
  ] as const)("%s to %s allowed: %s", (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });

  it("refuses any transition out of a final status", () => {
    for (const status of ["bounced", "complained", "failed"] as const) {
      expect(nextStatuses(status)).toHaveLength(0);
      expect(isTerminal(status)).toBe(true);
    }
  });

  it("still refuses delivered back to sent, deferred or queued", () => {
    for (const status of ["sent", "deferred", "queued", "failed"] as const) {
      expect(canTransition("delivered", status)).toBe(false);
    }
  });

  // Settled and final are different questions. A progress view stops waiting on a delivered
  // message; the lifecycle still has somewhere for it to go.
  it("counts delivered as settled even though it can still move", () => {
    expect(isTerminal("delivered")).toBe(true);
    expect(nextStatuses("delivered")).not.toHaveLength(0);
  });

  it("does not treat deferred as terminal", () => {
    expect(isTerminal("deferred")).toBe(false);
  });

  it("names both statuses when it refuses a transition", () => {
    expect(() => assertTransition("delivered", "sent")).toThrow("A message can't go from delivered to sent.");
  });

  it("allows a legal transition through the guard", () => {
    expect(() => assertTransition("queued", "sent")).not.toThrow();
  });
});

describe("process lifecycle", () => {
  afterEach(() => resetLifecycle());

  it("runs hooks in reverse registration order", async () => {
    const order: string[] = [];
    onShutdown("first", () => void order.push("first"));
    onShutdown("second", () => void order.push("second"));

    await runShutdownNow();

    expect(order).toEqual(["second", "first"]);
  });

  it("replaces a hook registered under the same name", async () => {
    const order: string[] = [];
    onShutdown("worker", () => void order.push("stale"));
    onShutdown("worker", () => void order.push("fresh"));

    await runShutdownNow();

    expect(order).toEqual(["fresh"]);
  });

  it("runs the remaining hooks when one throws", async () => {
    const order: string[] = [];
    onShutdown("throws", () => {
      throw new Error("boom");
    });
    onShutdown("later", () => void order.push("later"));

    await runShutdownNow();

    expect(order).toEqual(["later"]);
  });

  it("runs the queue only once", async () => {
    let calls = 0;
    onShutdown("counted", () => void (calls += 1));

    await runShutdownNow();
    await runShutdownNow();

    expect(calls).toBe(1);
  });

  it("listens for SIGTERM and SIGINT on the first hook, unless the host has claimed them", () => {
    const once = vi.spyOn(process, "once").mockImplementation(() => process);
    try {
      resetLifecycle();
      onShutdown("owned", () => {});
      expect(once.mock.calls.map(([event]) => event)).toEqual(["SIGTERM", "SIGINT", "beforeExit"]);

      once.mockClear();
      resetLifecycle();
      deferSignalsToHost();
      onShutdown("deferred", () => {});
      expect(once.mock.calls.map(([event]) => event)).toEqual(["beforeExit"]);
    } finally {
      once.mockRestore();
    }
  });

  it("makes a second caller wait on the shutdown already running", async () => {
    let release!: () => void;
    let finished = false;
    onShutdown("slow", () => new Promise<void>((resolve) => (release = resolve)).then(() => void (finished = true)));

    const first = runShutdownNow("SIGTERM");
    let secondDone = false;
    void runShutdownNow("beforeExit").then(() => (secondDone = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondDone).toBe(false);

    release();
    await first;
    await new Promise((resolve) => setImmediate(resolve));

    expect(finished).toBe(true);
    expect(secondDone).toBe(true);
  });

  describe("budgets", () => {
    afterEach(() => vi.useRealTimers());

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function track(promise: Promise<void>): { done: boolean } {
      const state = { done: false };
      void promise.then(() => (state.done = true));
      return state;
    }

    it("waits past the short budget for a hook flagged as a drain, whatever its name", async () => {
      vi.useFakeTimers();
      let finished = false;
      onShutdown("worker:exports", () => sleep(30_000).then(() => void (finished = true)), { drain: true });

      const shutdown = track(runShutdownNow());
      await vi.advanceTimersByTimeAsync(29_000);
      expect(shutdown.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(finished).toBe(true);
      expect(shutdown.done).toBe(true);
    });

    it("gives an unflagged hook the short budget even when its name ends in :loop", async () => {
      vi.useFakeTimers();
      onShutdown("worker:loop", () => new Promise<void>(() => {}));

      const shutdown = track(runShutdownNow());
      await vi.advanceTimersByTimeAsync(8_000);

      expect(shutdown.done).toBe(true);
    });

    it("gives a hook its own budget in place of the default", async () => {
      vi.useFakeTimers();
      onShutdown("short", () => new Promise<void>(() => {}), { timeoutMs: 1_000 });
      onShutdown("drain", () => new Promise<void>(() => {}), { drain: true, timeoutMs: 2_000 });

      const shutdown = track(runShutdownNow());
      await vi.advanceTimersByTimeAsync(2_000);
      expect(shutdown.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(shutdown.done).toBe(true);
    });

    it("runs drains together, then the rest", async () => {
      vi.useFakeTimers();
      const order: string[] = [];
      onShutdown("db", () => void order.push("db"));
      onShutdown("first", () => sleep(20_000).then(() => void order.push("first")), { drain: true });
      onShutdown("second", () => sleep(20_000).then(() => void order.push("second")), { drain: true });

      const shutdown = track(runShutdownNow());
      await vi.advanceTimersByTimeAsync(20_000);

      expect(shutdown.done).toBe(true);
      expect(order).toEqual(["first", "second", "db"]);
    });
  });
});
