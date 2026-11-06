import { describe, expect, it } from "vitest";
import { jobState, staleWindowMs } from "@/lib/health/jobs";

const NOW = new Date("2026-10-03T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const row = (intervalMs: number, beatAgoMs: number, lastError: string | null = null) => ({ intervalMs, lastBeatAt: ago(beatAgoMs), lastError });

describe("jobState", () => {
  it("is ok at exactly its window, so a run landing a moment late isn't an alarm", () => {
    expect(jobState(row(60_000, staleWindowMs(60_000)), NOW)).toBe("ok");
  });

  it("is stale a moment past its window", () => {
    expect(jobState(row(60_000, staleWindowMs(60_000) + 1), NOW)).toBe("stale");
  });

  it("judges an hourly job against an hour, not a shared minute", () => {
    expect(jobState(row(60 * 60_000, 2 * 60 * 60_000), NOW)).toBe("ok");
    expect(jobState(row(60 * 60_000, 4 * 60 * 60_000), NOW)).toBe("stale");
  });

  it("gives a fast job a floor under its window", () => {
    expect(jobState(row(2000, 10_000), NOW)).toBe("ok");
    expect(jobState(row(2000, 16_000), NOW)).toBe("stale");
  });

  it("is failing when the last run threw and it's still inside its window", () => {
    expect(jobState(row(60_000, 30_000, "The last run threw."), NOW)).toBe("failing");
  });

  it("reads stale over failing: a job that threw and then stopped has stopped", () => {
    expect(jobState(row(60_000, 10 * 60_000, "The last run threw."), NOW)).toBe("stale");
  });

  it("is never with no row", () => {
    expect(jobState(null, NOW)).toBe("never");
  });
});
