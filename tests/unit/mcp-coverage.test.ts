import { describe, expect, it } from "vitest";
import { ROUTES } from "@/lib/api-docs/spec";
import { MCP_TOOLS } from "@/lib/mcp/registry";

/** Documented routes with no tool. Every entry needs a reason. */
const NO_TOOL: Record<string, string> = {
  "POST /v1/confirm": "Takes a token, not a key.",
  "POST /v1/unsubscribe": "Takes a token, not a key.",
  "GET /v1/events": "Held open with no terminal state; see docs/mcp.md.",
};

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
const covered = new Set(MCP_TOOLS.map((tool) => key(tool.route)));

describe("the MCP registry covers the API", () => {
  it("has a tool for every documented route outside NO_TOOL", () => {
    const missing = ROUTES.map(key).filter((route) => !covered.has(route) && !(route in NO_TOOL));
    expect(missing).toEqual([]);
  });

  it("lists only documented, uncovered routes in NO_TOOL", () => {
    const documented = new Set(ROUTES.map(key));
    const stale = Object.keys(NO_TOOL).filter((route) => !documented.has(route) || covered.has(route));
    expect(stale).toEqual([]);
  });

  it("marks exactly the /v1/admin tools admin-only", () => {
    const misfiled = MCP_TOOLS.filter((tool) => Boolean(tool.admin) !== tool.route.path.startsWith("/v1/admin/")).map((tool) => tool.name);
    expect(misfiled).toEqual([]);
  });

  it("gives every admin route a tool", () => {
    const admin = ROUTES.filter((r) => r.path.startsWith("/v1/admin/"));
    expect(admin.length).toBeGreaterThan(0);
    expect(admin.map(key).filter((route) => !covered.has(route))).toEqual([]);
  });

  it("excludes only key-free routes, apart from GET /v1/events", () => {
    const keyed = ROUTES.filter((r) => key(r) in NO_TOOL && r.auth.startsWith("Bearer key")).map(key);
    expect(keyed).toEqual(["GET /v1/events"]);
  });
});
