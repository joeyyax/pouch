import { describe, expect, it, vi } from "vitest";
import { fromStored, toStored, watchChecks, type CheckState, type HealthTransition, type WatchStore } from "@/lib/health/watch";
import type { CheckReport } from "@/lib/health/registry";

function memoryStore(): WatchStore {
  let state: Record<string, CheckState> = {};
  return { read: async () => state, write: async (next) => void (state = next) };
}

/** Stores the way Redis does: the shared hash plus the suspect set. */
function encodedStore(): WatchStore & { stored: () => ReturnType<typeof toStored> } {
  let stored = toStored({});
  return {
    read: async () => fromStored(stored.state, stored.suspect),
    write: async (next) => void (stored = toStored(next)),
    stored: () => stored,
  };
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

  it("stays silent through one failing pass that clears", async () => {
    const store = memoryStore();
    const push = vi.fn().mockResolvedValue(undefined);
    const pass = (ok: boolean) => watchChecks(store, report(["storage", ok]), push);

    await pass(true);
    await pass(false);
    await pass(true);
    await pass(false);
    await pass(true);

    expect(push).not.toHaveBeenCalled();
  });

  it("announces a check failing since it was first seen on the second pass, and stays quiet for one that's healthy", async () => {
    const store = memoryStore();
    const push = vi.fn().mockResolvedValue(undefined);
    const pass = () => watchChecks(store, report(["postgres", true], ["storage", false]), push);

    expect(await pass()).toEqual([]);
    expect((await pass()).map((t) => t.check)).toEqual(["storage"]);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("tracks each check on its own", async () => {
    const store = memoryStore();
    const push = vi.fn().mockResolvedValue(undefined);
    await watchChecks(store, report(["redis", true], ["storage", true]), push);

    await watchChecks(store, report(["redis", false], ["storage", true]), push);
    await watchChecks(store, report(["redis", false], ["storage", false]), push);
    await watchChecks(store, report(["redis", false], ["storage", false]), push);

    expect(push.mock.calls.map(([t]) => t.check)).toEqual(["redis", "storage"]);
  });

  it("doesn't repeat a push that failed", async () => {
    const store = memoryStore();
    const push = vi.fn().mockRejectedValueOnce(new Error("ntfy responded 503")).mockResolvedValue(undefined);
    await watchChecks(store, report(["redis", true]), push);

    await watchChecks(store, report(["redis", false]), push);
    await watchChecks(store, report(["redis", false]), push);
    await watchChecks(store, report(["redis", false]), push);

    expect(push).toHaveBeenCalledTimes(1);
  });

  it("keeps suspicion out of the shared hash, so an older release reads one failing pass as ok", async () => {
    const store = encodedStore();
    const push = vi.fn().mockResolvedValue(undefined);
    const pass = (ok: boolean) => watchChecks(store, report(["storage", ok]), push);

    await pass(true);
    await pass(false);
    expect(store.stored()).toEqual({ state: { storage: "ok" }, suspect: ["storage"] });

    await pass(false);
    expect(store.stored()).toEqual({ state: { storage: "failing" }, suspect: [] });
    expect(push.mock.calls.map(([t]) => `${t.check}:${t.to}`)).toEqual(["storage:failing"]);
  });
});
