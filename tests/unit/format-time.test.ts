import { describe, expect, it } from "vitest";
import {
  absoluteTime,
  byteLabel,
  clockTime,
  dayLabel,
  durationLabel,
  timeLabel,
  untilLabel,
  zoneLabel,
  zonedTime,
} from "@/lib/format/time";

const LA = "America/Los_Angeles";

const now = new Date("2026-09-08T14:36:00Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

describe("timeLabel", () => {
  it("counts seconds, minutes and hours under a day", () => {
    expect(timeLabel(ago(1), "UTC", now)).toBe("1 second ago");
    expect(timeLabel(ago(59), "UTC", now)).toBe("59 seconds ago");
    expect(timeLabel(ago(60), "UTC", now)).toBe("1 minute ago");
    expect(timeLabel(ago(3599), "UTC", now)).toBe("59 minutes ago");
    expect(timeLabel(ago(3600), "UTC", now)).toBe("1 hour ago");
    expect(timeLabel(ago(86_399), "UTC", now)).toBe("23 hours ago");
  });

  it("switches to an absolute stamp at a day", () => {
    expect(timeLabel(ago(86_400), "UTC", now)).toBe("2026-09-07 14:36");
  });

  it("never reports a future date as negative", () => {
    expect(timeLabel(new Date(now.getTime() + 60_000), "UTC", now)).toBe("1 second ago");
  });
});

describe("untilLabel", () => {
  const ahead = (seconds: number) => new Date(now.getTime() + seconds * 1000);

  it("counts forward under a day", () => {
    expect(untilLabel(ahead(1), "UTC", now)).toBe("in 1 second");
    expect(untilLabel(ahead(90), "UTC", now)).toBe("in 1 minute");
    expect(untilLabel(ahead(37 * 60), "UTC", now)).toBe("in 37 minutes");
    expect(untilLabel(ahead(7200), "UTC", now)).toBe("in 2 hours");
  });

  it("switches to an absolute stamp at a day", () => {
    expect(untilLabel(ahead(86_400), "UTC", now)).toBe("2026-09-09 14:36");
  });

  it("says now once the moment has passed", () => {
    expect(untilLabel(ago(60), "UTC", now)).toBe("now");
  });
});

describe("stamps", () => {
  it("formats in UTC when that's the zone", () => {
    const date = new Date("2026-09-07T14:32:07Z");
    expect(absoluteTime(date, "UTC")).toBe("2026-09-07 14:32");
    expect(clockTime(date, "UTC")).toBe("14:32:07");
    expect(dayLabel(date, "UTC")).toBe("2026-09-07");
  });

  it("formats in the viewer's zone, across midnight and DST", () => {
    const late = new Date("2026-09-08T03:05:09Z");
    expect(absoluteTime(late, LA)).toBe("2026-09-07 20:05");
    expect(clockTime(late, LA)).toBe("20:05:09");
    expect(dayLabel(late, LA)).toBe("2026-09-07");
    expect(absoluteTime(new Date("2026-01-15T08:00:00Z"), LA)).toBe("2026-01-15 00:00");
    expect(absoluteTime(new Date("2026-09-07T00:30:00Z"), "Asia/Kolkata")).toBe("2026-09-07 06:00");
  });

  it("switches to an absolute stamp in the viewer's zone past a day", () => {
    expect(timeLabel(ago(86_400), LA, now)).toBe("2026-09-07 07:36");
  });

  it("names the zone as it stood at that moment", () => {
    expect(zoneLabel(new Date("2026-09-07T12:00:00Z"), LA)).toBe("PDT");
    expect(zoneLabel(new Date("2026-01-07T12:00:00Z"), LA)).toBe("PST");
    expect(zoneLabel(new Date("2026-01-07T12:00:00Z"), "UTC")).toBe("UTC");
    expect(zonedTime(new Date("2026-09-07T14:32:07Z"), LA)).toBe("2026-09-07 07:32 PDT");
  });
});

describe("durationLabel", () => {
  it("reads in minutes under an hour and hours after", () => {
    expect(durationLabel(ago(60), now)).toBe("1 minute");
    expect(durationLabel(ago(720), now)).toBe("12 minutes");
    expect(durationLabel(ago(7200), now)).toBe("2 hours");
  });
});

describe("byteLabel", () => {
  it("scales to the unit that reads", () => {
    expect(byteLabel(512)).toBe("512 B");
    expect(byteLabel(86_016)).toBe("84 KB");
    expect(byteLabel(2_202_010)).toBe("2.1 MB");
  });
});
