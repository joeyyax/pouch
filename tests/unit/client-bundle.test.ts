import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * Packages that only run on a server. A "use client" file that reaches one of these compiles,
 * typechecks and lints clean, then fails in the browser with "Can't resolve 'net'" and renders
 * a blank screen.
 */
const SERVER_ONLY = [
  "postgres",
  "ioredis",
  "@aws-sdk/",
  "node:",
  "drizzle-orm/postgres-js",
  // better-auth/react and @better-auth/passkey/client are the browser entry points and are fine;
  // the bare package and its adapters are the server.
  "better-auth/adapters/",
];

function serverOnly(adapter: string): boolean {
  if (adapter === "better-auth") return true;
  return SERVER_ONLY.some((banned) => adapter.startsWith(banned));
}

const EXTENSIONS = [".ts", ".tsx"];

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, found);
    else if (EXTENSIONS.some((extension) => path.endsWith(extension))) found.push(path);
  }
  return found;
}

/** Resolves a specifier the way the bundler does, or null when it isn't a local file. */
function resolveLocal(specifier: string, from: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(ROOT, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  if (!base) return null;

  for (const candidate of [
    ...EXTENSIONS.map((extension) => `${base}${extension}`),
    ...EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
}

const IMPORT = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)\s*from\s*["']([^"']+)["']/g;

/**
 * Specifiers a file pulls in at runtime. `import type` and braces holding only `type` specifiers
 * are erased by the compiler and can't put anything in a bundle.
 */
function runtimeImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const [, clause, specifier] of source.matchAll(IMPORT)) {
    const text = clause ?? "";
    if (/^type\s/.test(text.trim())) continue;

    const braces = /\{([\s\S]*)\}/.exec(text);
    const outside = text.replace(/\{[\s\S]*\}/, "").replace(/,/g, "").trim();
    if (braces && outside === "") {
      const names = (braces[1] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
      if (names.length > 0 && names.every((name) => name.startsWith("type "))) continue;
    }
    specifiers.push(specifier ?? "");
  }
  return specifiers;
}

/** Every adapter the file reaches at runtime, and the path it took to get there. */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: [file: string, trail: string[]][] = [[entry, [entry]]];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const [file, trail] = next;
    if (seen.has(file)) continue;
    seen.set(file, trail);

    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    for (const specifier of runtimeImports(source)) {
      // A server action is a reference across the boundary, never inlined into the bundle.
      const local = resolveLocal(specifier, file);
      if (local) {
        if (readFileSync(local, "utf8").trimStart().startsWith('"use server"')) continue;
        queue.push([local, [...trail, local]]);
      } else {
        seen.set(specifier, [...trail, specifier]);
      }
    }
  }

  return seen;
}

const clientFiles = walk(join(ROOT, "app"))
  .concat(walk(join(ROOT, "components")))
  .filter((file) => readFileSync(file, "utf8").trimStart().startsWith('"use client"'));

describe("the client bundle", () => {
  it("finds the client components to check", () => {
    expect(clientFiles.length).toBeGreaterThan(10);
  });

  it.each(clientFiles.map((file) => [file.slice(ROOT.length + 1), file]))(
    "%s reaches nothing server-only",
    (_label, file) => {
      const reached = reachable(file);
      const offenders = [...reached.entries()]
        .filter(([adapter]) => serverOnly(adapter))
        .map(([adapter, trail]) => `${adapter} via ${trail.map((step) => step.replace(`${ROOT}/`, "")).join(" → ")}`);

      expect(offenders).toEqual([]);
    },
  );
});
