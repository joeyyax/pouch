import { describe, expect, it } from "vitest";
import { formatNumber, formatOrdinal } from "@/lib/format/number";

describe("formatNumber", () => {
  it("groups thousands", () => {
    expect(formatNumber(1234)).toBe("1,234");
  });
});

describe("formatOrdinal", () => {
  it("spells first to tenth", () => {
    expect([1, 2, 3, 5, 10].map(formatOrdinal)).toEqual(["first", "second", "third", "fifth", "tenth"]);
  });

  it("writes digits and a suffix past ten", () => {
    expect([11, 12, 13, 21, 22, 23, 24, 101, 111, 1003].map(formatOrdinal)).toEqual([
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "24th",
      "101st",
      "111th",
      "1,003rd",
    ]);
  });
});
