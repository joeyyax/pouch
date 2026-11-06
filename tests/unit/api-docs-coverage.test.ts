import { describe, expect, it } from "vitest";
import { ROUTES } from "@/lib/api-docs/spec";
import { handlerKey as key, servedRoutes } from "./served-routes";

const served = servedRoutes();
const documented = ROUTES.map((route) => ({ method: route.method, path: route.path }));

describe("the API reference covers the API", () => {
  it("finds the route files at all", () => {
    // A glob that quietly matches nothing would make every assertion below vacuous.
    expect(served.length).toBeGreaterThan(5);
  });

  it("documents every route the service serves", () => {
    const missing = served.filter((h) => !documented.some((d) => key(d) === key(h))).map(key);
    expect(missing).toEqual([]);
  });

  it("has no entry for a route that doesn't exist", () => {
    const stale = documented.filter((d) => !served.some((h) => key(h) === key(d))).map(key);
    expect(stale).toEqual([]);
  });
});
