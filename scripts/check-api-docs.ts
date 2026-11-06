/**
 * Build-time gate for docs/api/conventions.md's promise: "A field without a `.describe()`
 * fails the docs build." Importing the spec walks every request schema through
 * lib/api-docs/introspect.ts, which throws on the first undocumented field. Run via `pnpm test`
 * (see package.json's pretest) and, independently, by the reference page itself rendering at
 * `next build` time — either one catches a regression.
 *
 * Then the surface check: every exported server action and dashboard route handler names a route
 * in lib/api-docs/spec.ts or records why the dashboard is its only surface (#393).
 */
import { ROUTES } from "@/lib/api-docs/spec";
import { dashboardSurfaces } from "@/lib/api-docs/surface-scan";
import { SURFACES } from "@/lib/api-docs/surfaces";

const fieldCount = ROUTES.reduce((total, route) => total + (route.request?.fields.length ?? 0) + (route.query?.fields.length ?? 0), 0);
console.log(`api docs: ${ROUTES.length} routes, ${fieldCount} request fields documented.`);

const found = dashboardSurfaces(process.cwd());

const undeclared = [...found].filter((key) => !SURFACES[key]).sort();
const stale = Object.keys(SURFACES).filter((key) => !found.has(key)).sort();

if (undeclared.length > 0 || stale.length > 0) {
  for (const key of undeclared) {
    console.error(`surfaces: ${key} has no entry. Name its route in lib/api-docs/surfaces.ts, or record why the dashboard is its only surface.`);
  }
  for (const key of stale) {
    console.error(`surfaces: ${key} is in lib/api-docs/surfaces.ts but no longer exists. Remove it.`);
  }
  process.exit(1);
}

const onlyDashboard = Object.values(SURFACES).filter((surface) => "only" in surface).length;
console.log(`surfaces: ${found.size} actions and handlers, ${found.size - onlyDashboard} on a route, ${onlyDashboard} dashboard-only by decision.`);
