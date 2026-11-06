/**
 * Finds every dashboard surface `lib/api-docs/surfaces.ts` has to account for: each exported
 * `*Action` in a "use server" file, and each HTTP method a handler under `app/api/dashboard/`
 * exports. Keys are `<file>#<name>`. Read by `pnpm check:docs` and the surface-parity test.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const EXPORTED_ACTION = /^export\s+(?:async\s+)?(?:function|const)\s+(\w+Action)\b/gm;
const EXPORTED_METHOD = /^export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm;

function files(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return files(path, keep);
    return keep(path) ? [path] : [];
  });
}

function keys(root: string, paths: string[], pattern: RegExp): string[] {
  return paths.flatMap((path) => {
    const file = relative(root, path).split(sep).join("/");
    return [...readFileSync(path, "utf8").matchAll(pattern)].map((match) => `${file}#${match[1]}`);
  });
}

/** Server actions: "use server" at the top makes every export of one callable from a page. */
export function actionSurfaces(root: string): string[] {
  const paths = files(join(root, "app"), (path) => path.endsWith(".ts") && readFileSync(path, "utf8").startsWith('"use server"'));
  return keys(root, paths, EXPORTED_ACTION);
}

/** Session-authenticated route handlers the dashboard fetches. */
export function handlerSurfaces(root: string): string[] {
  const paths = files(join(root, "app", "api", "dashboard"), (path) => /route\.tsx?$/.test(path));
  return keys(root, paths, EXPORTED_METHOD);
}

export function dashboardSurfaces(root: string): Set<string> {
  return new Set([...actionSurfaces(root), ...handlerSurfaces(root)]);
}
