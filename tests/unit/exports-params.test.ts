import { describe, expect, it } from "vitest";
import { filtersFromSearchParams } from "@/lib/exports/params";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T12:00:00.000Z");

describe("filtersFromSearchParams", () => {
  it("pins the default seven-day window to the request", () => {
    const filters = filtersFromSearchParams(new URLSearchParams(), NOW);
    expect(filters.since).toEqual(new Date(NOW.getTime() - 7 * DAY));
    expect(filters.screenWindow).toBe(true);
  });

  it("reads days, held and retried the way the screen does", () => {
    const filters = filtersFromSearchParams(new URLSearchParams("days=30&preset=held&retried=1"), NOW);
    expect(filters.since!.getTime()).toBeLessThanOrEqual(Date.now() - 30 * DAY + 1000);
    expect(filters.held).toBe(true);
    expect(filters.retried).toBe(true);
  });

  it("reads the attention preset into statuses", () => {
    expect(filtersFromSearchParams(new URLSearchParams("preset=attention"), NOW).statuses).toEqual([
      "deferred",
      "bounced",
      "complained",
      "failed",
    ]);
  });
});
