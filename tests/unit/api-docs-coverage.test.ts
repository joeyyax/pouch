import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTES } from "@/lib/api-docs/spec";

const ROOT = join(process.cwd(), "app/api/v1");
const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

interface Handler {
  method: string;
  path: string;
}

/** `app/api/v1/domains/[id]/verify/route.ts` → `/v1/domains/:id/verify`, the shape spec.ts uses. */
function routePath(file: string): string {
  const segments = file.slice(ROOT.length).split("/").filter(Boolean).slice(0, -1);
  return `/v1/${segments.map((s) => (s.startsWith("[") ? `:${s.slice(1, -1)}` : s)).join("/")}`.replace(/\/$/, "");
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === "route.ts" ? [full] : [];
  });
}

/** Verbs a file actually serves. `export const POST = rejected` answers 405, so it isn't one. */
function handlersIn(file: string): Handler[] {
  const source = readFileSync(file, "utf8");
  return VERBS.filter((verb) => {
    const body = source.match(new RegExp(`export const ${verb}\\s*=\\s*([^;]+);`))?.[1];
    return body !== undefined && body.trim() !== "rejected";
  }).map((method) => ({ method, path: routePath(file) }));
}

const served = routeFiles(ROOT).flatMap(handlersIn);
const documented = ROUTES.map((route) => ({ method: route.method, path: route.path }));
const key = (h: Handler) => `${h.method} ${h.path}`;

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
