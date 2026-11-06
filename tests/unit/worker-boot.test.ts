import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitBoot, beginShutdown, getBootError, isReady, markBooted, resetBoot } from "@/worker/boot";

describe("awaitBoot", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetBoot();
  });

  it("retries with backoff until releaseStaleLocks succeeds, then reports ready", async () => {
    vi.useFakeTimers();

    let calls = 0;
    const release = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("relation does not exist");
      return 0;
    });

    expect(isReady()).toBe(false);
    const booting = awaitBoot(release);
    await vi.advanceTimersByTimeAsync(0);
    expect(getBootError()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000 + 2000);

    await expect(booting).resolves.toBe(true);
    expect(calls).toBe(3);
    markBooted();
    expect(isReady()).toBe(true);
    expect(getBootError()).toBeNull();
  });

  it("stops retrying once a shutdown begins", async () => {
    vi.useFakeTimers();

    const release = vi.fn(async () => {
      throw new Error("relation does not exist");
    });

    const booting = awaitBoot(release);
    beginShutdown();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(booting).resolves.toBe(false);
    expect(isReady()).toBe(false);
  });
});
