import { describe, expect, it } from "vitest";
import { timeZoneOptions } from "@/lib/dashboard/user-settings";

describe("timeZoneOptions", () => {
  it("labels a zone by its current name and finds it by its old one and its aliases", async () => {
    const options = await timeZoneOptions(new Date("2026-01-15T12:00:00Z"));
    const find = (query: string) =>
      options.filter((option) => option.label.toLowerCase().includes(query) || option.aliases.some((alias) => alias.includes(query)));

    const india = options.find((option) => option.value === "Asia/Calcutta");
    expect(india?.label).toBe("Asia/Kolkata (GMT+05:30)");
    expect(india?.aliases).toContain("asia/calcutta");
    expect(find("kolkata").map((option) => option.value)).toEqual(["Asia/Calcutta"]);
    expect(find("calcutta").map((option) => option.value)).toEqual(["Asia/Calcutta"]);
    expect(find("kyiv").map((option) => option.value)).toEqual(["Europe/Kiev"]);
    expect(find("us/pacific").map((option) => option.value)).toEqual(["America/Los_Angeles"]);
    expect(options[0]).toMatchObject({ value: "UTC", label: "UTC" });
  });
});
