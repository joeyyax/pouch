import { describe, expect, it } from "vitest";
import { parseCsvRows } from "@/lib/lists/csv-parse";
import { parseMemberCsv } from "@/lib/lists/csv-import";

describe("parseCsvRows", () => {
  it("splits plain rows on commas and newlines", () => {
    expect(parseCsvRows("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles a quoted field containing a comma", () => {
    expect(parseCsvRows('a,"b,c"\n')).toEqual([["a", "b,c"]]);
  });

  it("unescapes a doubled quote inside a quoted field", () => {
    expect(parseCsvRows('"say ""hi"""\n')).toEqual([['say "hi"']]);
  });

  it("tolerates CRLF line endings", () => {
    expect(parseCsvRows("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("doesn't emit a phantom row for a trailing newline", () => {
    expect(parseCsvRows("a,b\n")).toEqual([["a", "b"]]);
  });
});

describe("parseMemberCsv", () => {
  it("reads address and turns other columns into attributes", () => {
    const result = parseMemberCsv("address,name\nada@example.com,Ada\n");
    expect(result.rows).toEqual([{ address: "ada@example.com", attributes: { name: "Ada" }, confirmed: undefined, line: 2 }]);
    expect(result.errors).toEqual([]);
  });

  it("reads the confirmed column as a boolean", () => {
    const result = parseMemberCsv("address,confirmed\nada@example.com,true\ngrace@example.com,false\n");
    expect(result.rows[0]?.confirmed).toBe(true);
    expect(result.rows[1]?.confirmed).toBe(false);
  });

  it("throws for a file with no address column", () => {
    expect(() => parseMemberCsv("name\nAda\n")).toThrow(/address/i);
  });

  it("throws for an empty file", () => {
    expect(() => parseMemberCsv("")).toThrow();
  });

  it("reports a missing address by line instead of throwing", () => {
    const result = parseMemberCsv("address,name\n,Ada\nb@example.com,Grace\n");
    expect(result.errors).toEqual([{ line: 2, address: "", message: "Address is required." }]);
    expect(result.rows).toEqual([{ address: "b@example.com", attributes: { name: "Grace" }, confirmed: undefined, line: 3 }]);
  });

  it("reports a row with the wrong column count by line", () => {
    const result = parseMemberCsv("address,name\na@example.com,Ada,extra\n");
    expect(result.errors[0]?.line).toBe(2);
    expect(result.errors[0]?.message).toMatch(/columns/);
  });

  it("round-trips the export header — address, status, source, confirmed_at, confirmed_by, unsubscribed_at, created_at, attributes", () => {
    const result = parseMemberCsv(
      "address,status,source,confirmed_at,confirmed_by,unsubscribed_at,created_at,attributes\nada@example.com,subscribed,manual,,not_required,,2026-01-01T00:00:00.000Z,{}\n",
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0]?.address).toBe("ada@example.com");
  });
});
