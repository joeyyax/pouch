// The API paths each optional feature owns. The features themselves are the boolean entries in `lib/settings/registry.ts`.
import type { Feature } from "@/lib/settings/registry";

export type { Feature } from "@/lib/settings/registry";

/** By segment, `:x` matching any one. The first match wins; null leaves a path open. */
const PATH_FEATURES: [string, Feature | null][] = [
  // Withdrawing consent works whatever is turned off.
  ["/v1/lists/:id/unsubscribe", null],
  ["/v1/lists", "lists"],
  ["/v1/batches", "bulk"],
  ["/v1/inbound", "inbound"],
  ["/v1/domains/:id/inbound", "inbound"],
  ["/v1/domains/:id/dmarc_reports", "dmarc_reports"],
  ["/v1/addresses", "addresses"],
  ["/mcp", "mcp"],
];

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** The feature an API path belongs to, or null for the core. Takes `/v1/...` or the handler's `/api/v1/...`. */
export function featureForPath(path: string): Feature | null {
  const parts = segments(path.replace(/^\/api(?=\/v1\/)/, ""));
  for (const [pattern, feature] of PATH_FEATURES) {
    const wanted = segments(pattern);
    if (wanted.length > parts.length) continue;
    if (wanted.every((part, index) => part.startsWith(":") || part === parts[index])) return feature;
  }
  return null;
}
