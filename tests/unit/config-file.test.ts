import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ConfigFileError, locateConfigFile, readConfigFile, stringifyConfigFile } from "@/lib/config-file";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "config-file-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe("locateConfigFile", () => {
  it("takes CONFIG_FILE over the default name", () => {
    expect(locateConfigFile("app.yml", { CONFIG_FILE: "/etc/app/custom.yml" })).toEqual({ path: "/etc/app/custom.yml", name: "custom.yml", explicit: true });
  });

  it("falls back to the default name in the working directory", () => {
    expect(locateConfigFile("app.yml", { CONFIG_FILE: " " })).toEqual({ path: join(process.cwd(), "app.yml"), name: "app.yml", explicit: false });
  });
});

describe("readConfigFile", () => {
  it("reads a mapping", () => {
    const path = write("app.yml", "one: 1\ntwo: true\n");
    expect(readConfigFile({ path, name: "app.yml", explicit: true })).toEqual({ one: 1, two: true });
  });

  it("answers null for a default file that isn't there", () => {
    expect(readConfigFile({ path: join(dir, "app.yml"), name: "app.yml", explicit: false })).toBeNull();
  });

  it("refuses a file CONFIG_FILE names that isn't there", () => {
    expect(() => readConfigFile({ path: join(dir, "app.yml"), name: "app.yml", explicit: true })).toThrow(/doesn't exist/);
  });

  it("refuses a directory, which a bind mount of a missing file creates", () => {
    const path = join(dir, "app.yml");
    mkdirSync(path);
    expect(() => readConfigFile({ path, name: "app.yml", explicit: false })).toThrow(/is a directory/);
  });

  it.each([
    ["malformed YAML", "one: [1\n", /isn't valid YAML/],
    ["a duplicate key", "one: 1\none: 2\n", /isn't valid YAML/],
    ["a list", "- one\n- two\n", /mapping/],
    ["a scalar", "just text\n", /mapping/],
  ])("refuses %s", (_label, text, message) => {
    const path = write("app.yml", text);
    expect(() => readConfigFile({ path, name: "app.yml", explicit: false })).toThrow(ConfigFileError);
    expect(() => readConfigFile({ path, name: "app.yml", explicit: false })).toThrow(message);
  });

  it("reads an empty file as no values", () => {
    const path = write("app.yml", "# nothing yet\n");
    expect(readConfigFile({ path, name: "app.yml", explicit: false })).toEqual({});
  });
});

describe("stringifyConfigFile", () => {
  it("writes groups under their comments, commented entries as comments, and reads back the set values", () => {
    const text = stringifyConfigFile(
      [
        { comment: "First", entries: [{ key: "a", value: true }, { key: "b", value: 2.5, commented: true }] },
        { comment: "Empty", entries: [] },
        { comment: "Second", entries: [{ key: "c", value: "word" }] },
      ],
      "Header\nSecond line",
    );
    expect(text).toBe("# Header\n# Second line\n\n# First\na: true\n# b: 2.5\n\n# Second\nc: word\n");
    expect(parse(text)).toEqual({ a: true, c: "word" });
  });
});
