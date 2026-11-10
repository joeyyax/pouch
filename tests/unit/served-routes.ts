import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "app/api/v1");
const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export interface Handler {
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

/** Every method and path under `app/api/v1`. */
export function servedRoutes(): Handler[] {
  return routeFiles(ROOT).flatMap(handlersIn);
}

export const handlerKey = (h: Handler) => `${h.method} ${h.path}`;
