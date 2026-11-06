import { describe, expect, it } from "vitest";
import { ROUTES } from "@/lib/api-docs/spec";
import { actionSurfaces, dashboardSurfaces, handlerSurfaces } from "@/lib/api-docs/surface-scan";
import { SURFACES } from "@/lib/api-docs/surfaces";

const ROOT = process.cwd();
const exported = dashboardSurfaces(ROOT);

const routeIds = new Set(ROUTES.map((route) => `${route.method} ${route.path}`));

describe("every dashboard surface has a surface record", () => {
  it("finds actions and route handlers to check", () => {
    expect(actionSurfaces(ROOT).length).toBeGreaterThan(0);
    expect(handlerSurfaces(ROOT).length).toBeGreaterThan(0);
  });

  it("declares every exported action and dashboard route handler", () => {
    expect([...exported].filter((key) => !SURFACES[key]).sort()).toEqual([]);
  });

  it("keeps no entry for a surface that's gone", () => {
    expect(Object.keys(SURFACES).filter((key) => !exported.has(key)).sort()).toEqual([]);
  });
});

describe("a surface record decides one of two things", () => {
  it("names a route that exists in the spec", () => {
    const missing = Object.entries(SURFACES)
      .filter(([, surface]) => "route" in surface && !routeIds.has(surface.route))
      .map(([action]) => action);
    expect(missing).toEqual([]);
  });

  it("gives a reason for every dashboard-only surface", () => {
    const unexplained = Object.entries(SURFACES)
      .filter(([, surface]) => "only" in surface && surface.reason.trim().length < 20)
      .map(([action]) => action);
    expect(unexplained).toEqual([]);
  });
});
