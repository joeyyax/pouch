import { describe, expect, it, vi } from "vitest";
import { withSlotDeadline } from "@/worker/loop";

describe("withSlotDeadline", () => {
  it("doesn't leave an unhandled rejection when the work fails after the deadline fired", async () => {
    // The backstop exists so one stuck send can't quietly stall the worker. Built the obvious
    // way — resolve(Promise.reject(err)) — it did something worse: on a settled promise resolve
    // is a no-op, nothing adopts that rejected promise, and worker/index.ts turns an unhandled
    // rejection into process.exit(1). The backstop killed the whole worker in exactly the case
    // it was written for.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => void unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const failsLate = new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error("late failure")), 60);
      });

      await withSlotDeadline(failsLate, "msg_1", 10);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("rejects into the caller when the work fails before the deadline", async () => {
    const failsFast = Promise.reject(new Error("provider exploded"));

    await expect(withSlotDeadline(failsFast, "msg_2", 5_000)).rejects.toThrow("provider exploded");
  });
});
