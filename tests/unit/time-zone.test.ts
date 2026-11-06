import { describe, expect, it } from "vitest";
import { timeZoneInput } from "@/lib/schemas/user-settings";
import { addDays, isTimeZone, startOfZonedDay, zoneName, zoneOrUtc, zonedDayKey } from "@/lib/time-zone";

describe("timeZoneInput", () => {
  it("accepts a listed IANA zone as itself", () => {
    expect(timeZoneInput.parse("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(timeZoneInput.parse(" Europe/Berlin ")).toBe("Europe/Berlin");
  });

  it("resolves an alias to the name the list uses", () => {
    expect(timeZoneInput.parse("US/Pacific")).toBe("America/Los_Angeles");
    expect(timeZoneInput.parse("Etc/UTC")).toBeNull();
  });

  it("stores UTC as null", () => {
    expect(timeZoneInput.parse("UTC")).toBeNull();
  });

  it("refuses a zone the runtime doesn't list, naming it", () => {
    const result = timeZoneInput.safeParse("Mars/Olympus_Mons");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Time zone "Mars/Olympus_Mons" isn\'t recognized. Pick one from the list.');
  });

  it("refuses an empty value, an offset and anything that would break out of SQL", () => {
    expect(timeZoneInput.safeParse("").error?.issues[0]?.message).toBe('Field "timeZone" is required.');
    expect(timeZoneInput.safeParse("+02:00").success).toBe(false);
    expect(timeZoneInput.safeParse("UTC' or '1'='1").success).toBe(false);
  });
});

describe("zone helpers", () => {
  it("lists UTC and every runtime zone", () => {
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("America/Los_Angeles")).toBe(true);
    expect(isTimeZone("Nowhere/Special")).toBe(false);
  });

  it("names a zone by what IANA calls it today", () => {
    expect(zoneName("Europe/Kiev")).toBe("Europe/Kyiv");
    expect(zoneName("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(zoneName("America/Los_Angeles")).toBe("America/Los Angeles");
    expect(timeZoneInput.parse("Asia/Kolkata")).toBe("Asia/Calcutta");
  });

  it("reads null and anything unlisted as UTC", () => {
    expect(zoneOrUtc(null)).toBe("UTC");
    expect(zoneOrUtc("Nowhere/Special")).toBe("UTC");
    expect(zoneOrUtc("Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("finds local midnight on both sides of a DST change", () => {
    const LA = "America/Los_Angeles";
    expect(startOfZonedDay("2026-03-08", LA).toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(startOfZonedDay("2026-03-09", LA).toISOString()).toBe("2026-03-09T07:00:00.000Z");
    expect(startOfZonedDay("2026-11-02", LA).toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(startOfZonedDay("2026-09-28", "Asia/Kolkata").toISOString()).toBe("2026-09-27T18:30:00.000Z");
    expect(zonedDayKey(new Date("2026-09-30T03:30:00.000Z"), LA)).toBe("2026-09-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
