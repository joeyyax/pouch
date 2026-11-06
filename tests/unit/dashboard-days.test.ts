import { describe, expect, it } from "vitest";
import { dayHeading, fillDays, groupByDay } from "@/lib/dashboard/views/days";

const LA = "America/Los_Angeles";

const NOW = new Date("2026-09-30T15:00:00.000Z");

describe("dayHeading", () => {
  it("names today and yesterday, then the date", () => {
    expect(dayHeading("2026-09-30", "UTC", NOW)).toBe("Today");
    expect(dayHeading("2026-09-29", "UTC", NOW)).toBe("Yesterday");
    expect(dayHeading("2026-09-28", "UTC", NOW)).toBe("Monday, September 28");
    expect(dayHeading("2025-12-31", "UTC", NOW)).toBe("December 31, 2025");
  });

  it("decides today in the viewer's zone", () => {
    // 22:00 on September 29 in Los Angeles.
    const evening = new Date("2026-09-30T05:00:00.000Z");
    expect(dayHeading("2026-09-29", LA, evening)).toBe("Today");
    expect(dayHeading("2026-09-28", LA, evening)).toBe("Yesterday");
    expect(dayHeading("2026-09-30", "UTC", evening)).toBe("Today");
  });
});

describe("groupByDay", () => {
  it("splits a newest-first list at each UTC midnight and keeps order", () => {
    const items = [
      new Date("2026-09-30T00:10:00.000Z"),
      new Date("2026-09-29T23:50:00.000Z"),
      new Date("2026-09-29T01:00:00.000Z"),
      new Date("2026-09-27T12:00:00.000Z"),
    ];
    const groups = groupByDay(items, (date) => date, "UTC");
    expect(groups.map((group) => [group.day, group.items.length])).toEqual([
      ["2026-09-30", 1],
      ["2026-09-29", 2],
      ["2026-09-27", 1],
    ]);
  });

  it("puts 23:30 UTC on the Los Angeles day it happened", () => {
    const items = [new Date("2026-09-29T23:30:00.000Z"), new Date("2026-09-29T07:01:00.000Z"), new Date("2026-09-29T06:59:00.000Z")];
    expect(groupByDay(items, (date) => date, LA).map((group) => [group.day, group.items.length])).toEqual([
      ["2026-09-29", 2],
      ["2026-09-28", 1],
    ]);
  });
});

describe("fillDays", () => {
  it("covers every day in the window and zeros the gaps", () => {
    const days = fillDays(new Date("2026-09-27T18:00:00.000Z"), NOW, [{ day: "2026-09-29", total: 4, flagged: 1 }], "UTC");
    expect(days).toEqual([
      { day: "2026-09-27", total: 0, flagged: 0 },
      { day: "2026-09-28", total: 0, flagged: 0 },
      { day: "2026-09-29", total: 4, flagged: 1 },
      { day: "2026-09-30", total: 0, flagged: 0 },
    ]);
  });
});

describe("fillDays in a zone", () => {
  it("counts days by the zone's calendar, through a DST change", () => {
    const days = fillDays(new Date("2026-11-01T06:30:00.000Z"), new Date("2026-11-03T07:30:00.000Z"), [], LA);
    expect(days.map((day) => day.day)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
  });
});
