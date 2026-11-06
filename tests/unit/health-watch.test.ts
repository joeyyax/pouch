import { describe, expect, it, vi } from "vitest";
import { watchChecks, type CheckState, type HealthTransition, type WatchStore } from "@/lib/health/watch";
import type { CheckReport } from "@/lib/health/registry";

function memoryStore(): WatchStore {
  let state: Record<string, CheckState> = {};
  return { read: async () => state, write: async (next) => void (state = next) };
}

function report(...entries: [string, boolean][]): Record<string, CheckReport> {
  return Object.fromEntries(entries.map(([name, ok]) => [name, { ok, critical: true, detail: ok ? null : "Down." }]));
}

describe("health watch", () => {
  it("announces a failure once, stays silent while it lasts, and announces the recovery once", async () => {
    const store = memoryStore();
    const push = vi.fn<(transition: HealthTransition) => Promise<void>>().mockResolvedValue(undefined);
    const pass = (ok: boolean) => watchChecks(store, report(["redis", ok]), push);

    await pass(true);
    expect(push).not.toHaveBeenCalled();

    await pass(false);
    await pass(false);
    await pass(false);
    expect(push.mock.calls.map(([t]) => `${t.check}:${t.to}`)).toEqual(["redis:failing"]);

    await pass(true);
    await pass(true);
    expect(push.mock.calls.map(([t]) => `${t.check}:${t.to}`)).toEqual(["redis:failing", "redis:ok"]);
  });

  it("announces a check that is failing the first time it's seen, and stays quiet for one that's healthy", async () => {
    const push = vi.fn().mockResolvedValue(undefined);

    const found = await watchChecks(memoryStore(), report(["postgres", true], ["storage", false]), push);

    expect(found.map((t) => t.check)).toEqual(["storage"]);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("tracks each check on its own", async () => {
    const store = memoryStore();
    const push = vi.fn().mockResolvedValue(undefined);
    await watchChecks(store, report(["redis", true], ["storage", true]), push);

    await watchChecks(store, report(["redis", false], ["storage", true]), push);
    await watchChecks(store, report(["redis", false], ["storage", false]), push);

    expect(push.mock.calls.map(([t]) => t.check)).toEqual(["redis", "storage"]);
  });

  it("doesn't repeat a push that failed", async () => {
    const store = memoryStore();
    const push = vi.fn().mockRejectedValueOnce(new Error("ntfy responded 503")).mockResolvedValue(undefined);
    await watchChecks(store, report(["redis", true]), push);

    await watchChecks(store, report(["redis", false]), push);
    await watchChecks(store, report(["redis", false]), push);

    expect(push).toHaveBeenCalledTimes(1);
  });
});
