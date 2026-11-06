import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { LOOP_NAMES } from "@/lib/health/names";
import { logger } from "@/lib/logger";

const WORKER_DIR = path.resolve(import.meta.dirname, "../../worker");

/**
 * Every loop's name, read from the source rather than by instantiating twelve classes with twelve
 * different option shapes. Two forms count: a subclass of IntervalLoop declaring its name, and
 * SendLoop, which owns its own lifecycle and calls recordJobStart directly.
 */
function declaredLoopNames(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(WORKER_DIR).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(path.join(WORKER_DIR, file), "utf8");
    for (const match of source.matchAll(/protected readonly name = "([a-z-]+)"/g)) names.add(match[1]!);
    for (const match of source.matchAll(/recordJobStart\("([a-z-]+)"/g)) names.add(match[1]!);
  }
  return names;
}

describe("loop registry", () => {
  it("every running loop is on the admin system screen, and every name on it is running", () => {
    // The failure this prevents: four of twelve loops reported no heartbeat, so a dead stall
    // guard — the thing that stops a bouncing domain burning the sending reputation — looked
    // exactly like a healthy one. Adding a loop without a name, or a name without a loop, fails
    // here rather than showing up as a silence nobody reads.
    expect([...declaredLoopNames()].sort()).toEqual([...LOOP_NAMES].sort());
  });
});

describe("worker shutdown", () => {
  it("registers every loop as a drain", () => {
    const source = readFileSync(path.join(WORKER_DIR, "index.ts"), "utf8");
    const stops = [...source.matchAll(/onShutdown\("([^"]+)", \(\) => \w+\.stop\(\)(, \{ drain: true \})?\)/g)];

    expect(stops).toHaveLength(declaredLoopNames().size);
    expect(stops.filter((match) => !match[2]).map((match) => match[1])).toEqual([]);
  });
});

class TestLoop extends IntervalLoop<number> {
  protected readonly name = "retention";
  protected readonly log = logger.child("test");
  protected readonly intervalMs = 50;

  passes = 0;
  release: (() => void) | null = null;
  finished = false;

  protected async run(): Promise<number> {
    this.passes += 1;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.finished = true;
    return this.passes;
  }
}

describe("IntervalLoop", () => {
  it("stop() waits for the pass in flight instead of cutting it mid-write", async () => {
    // Four loops had returned from stop() without awaiting, so a retention shred or an export
    // artifact write could be cut off on every SIGTERM. They were fixed one by one first; this
    // is the property that stops the next loop reintroducing it.
    const loop = new TestLoop();
    void loop.tick();
    await vi.waitFor(() => expect(loop.release).not.toBeNull());

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(loop.finished).toBe(false);

    loop.release!();
    await stopping;
    expect(loop.finished).toBe(true);
  });

  it("a tick arriving mid-pass joins it rather than stacking a second pass over the same rows", async () => {
    const loop = new TestLoop();
    const first = loop.tick();
    await vi.waitFor(() => expect(loop.release).not.toBeNull());
    const second = loop.tick();

    loop.release!();
    // Both callers get the same pass: run() ran once, and the second tick resolves with its
    // result rather than starting a sweep over the same rows.
    expect(await second).toBe(await first);
    expect(loop.passes).toBe(1);

    await loop.stop();
  });

  it("a failing pass is reported and the loop keeps its schedule", async () => {
    class FailingLoop extends IntervalLoop<number> {
      protected readonly name = "retention";
      protected readonly log = logger.child("test");
      protected readonly intervalMs = 5;
      attempts = 0;
      protected async run(): Promise<number> {
        this.attempts += 1;
        throw new Error("every tick throws");
      }
    }

    const loop = new FailingLoop();
    vi.spyOn(console, "error").mockImplementation(() => {});
    loop.start();

    // A loop whose every tick throws must keep ticking, not silently stop.
    await vi.waitFor(() => expect(loop.attempts).toBeGreaterThan(1), { timeout: 2_000 });
    await loop.stop();
  });
});
