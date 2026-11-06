import { describe, expect, it } from "vitest";
import { csvField, csvRow } from "@/lib/exports/csv";
import { parseCsvRows } from "@/lib/lists/csv-parse";

describe("CSV formula guard", () => {
  it.each(["=SUM(A1)", "+1", "-1", "@cmd", "\tx", "\rx"])("prefixes %j so a spreadsheet reads it as text", (value) => {
    expect(csvField(value).replace(/^"/, "").startsWith(`'${value[0]}`)).toBe(true);
  });

  it("leaves ordinary strings, numbers and a quote mid-value alone", () => {
    expect(csvField("ada@example.com")).toBe("ada@example.com");
    expect(csvField(-3)).toBe("-3");
    expect(csvField("it's")).toBe("it's");
  });

  it("reads every guarded cell back as it was", () => {
    const values = ["-ada@example.com", "+grace@example.com", '=HYPERLINK("http://x","y")', "@home", "\tlead", "'quoted", "plain"];
    expect(parseCsvRows(csvRow(values))).toEqual([values]);
  });
});
