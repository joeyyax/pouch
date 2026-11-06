import { describe, expect, it } from "vitest";
import { llmsFull, llmsIndex } from "@/lib/api-docs/llms";
import { referenceUrl } from "@/lib/api-docs/links";
import { ROUTES } from "@/lib/api-docs/spec";

const BASE = "https://pouch.test";

describe("llms.txt", () => {
  it("lists every route with a link to its reference page", () => {
    const text = llmsIndex(BASE);
    expect(text.startsWith("# Pouch\n\n> ")).toBe(true);
    for (const route of ROUTES) expect(text).toContain(`[${route.method} ${route.path}](${referenceUrl(route)})`);
    expect(text).toContain(`${BASE}/llms-full.txt`);
  });

  it("spells out each route's fields and the error codes in the full file", () => {
    const text = llmsFull(BASE);
    expect(text).toContain("### POST /v1/emails");
    expect(text).toMatch(/- `to` \(.+; required/);
    expect(text).toContain("## Error codes");
    expect(text).toContain("- `invalid_key` (401)");
  });
});
