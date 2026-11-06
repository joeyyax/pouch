import { describe, expect, it } from "vitest";
import { groupLoops, healthyLoopsLabel, type JobState, type LoopLivenessView, type LoopName } from "@/lib/system/views";

const loop = (name: string, status: JobState): LoopLivenessView => ({
  loop: name as LoopName,
  label: name,
  status,
  lastRunAt: null,
  intervalMs: 60_000,
  consecutiveFailures: 0,
});

describe("groupLoops", () => {
  it("puts nothing in attention when every loop is alive", () => {
    const { attention, healthy } = groupLoops([loop("a", "ok"), loop("b", "ok")]);
    expect(attention).toEqual([]);
    expect(healthy.map((l) => l.loop)).toEqual(["a", "b"]);
  });

  it("leads with failing, then silent, then never run, and keeps registry order within a state", () => {
    const { attention, healthy } = groupLoops([
      loop("a", "never"),
      loop("b", "ok"),
      loop("c", "stale"),
      loop("d", "failing"),
      loop("e", "stale"),
    ]);
    expect(attention.map((l) => l.loop)).toEqual(["d", "c", "e", "a"]);
    expect(healthy.map((l) => l.loop)).toEqual(["b"]);
  });

  it("leaves the list it was given in order", () => {
    const loops = [loop("a", "stale"), loop("b", "failing")];
    groupLoops(loops);
    expect(loops.map((l) => l.loop)).toEqual(["a", "b"]);
  });
});

describe("healthyLoopsLabel", () => {
  it("counts every loop when nothing needs a look", () => {
    expect(healthyLoopsLabel(17, false)).toBe("17 loops alive");
    expect(healthyLoopsLabel(1, false)).toBe("1 loop alive");
  });

  it("says other under rows that need a look", () => {
    expect(healthyLoopsLabel(14, true)).toBe("14 other loops alive");
    expect(healthyLoopsLabel(1, true)).toBe("1 other loop alive");
  });
});
