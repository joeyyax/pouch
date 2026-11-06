import { describe, expect, it } from "vitest";
import { localPath } from "@/lib/dashboard/local-path";

describe("localPath", () => {
  it.each(["/", "/domains/dom_1/reputation", "/activity?family=session&outcome=failure"])("keeps %s", (path) => {
    expect(localPath(path)).toBe(path);
  });

  it.each(["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)", "domains", "/a\nb", "", null, 42])(
    "refuses %s",
    (value) => {
      expect(localPath(value)).toBeNull();
    },
  );
});
