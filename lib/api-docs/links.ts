/** Where the docs site keeps each page. No schemas, so client components can import it. */

export const DOCS_URL = "https://pouch.email/docs";

export const REFERENCE_URL = `${DOCS_URL}/reference/`;

export const SMTP_DOCS_URL = `${DOCS_URL}/smtp/`;

interface RouteKey {
  method: string;
  path: string;
}

/** A route's operationId, and the last segment of its reference page. */
export function operationId(route: RouteKey): string {
  return `${route.method}-${route.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`.toLowerCase();
}

const TAGS: Record<string, string> = {
  domains: "Domains",
  emails: "Emails",
  batches: "Batches",
  events: "Events",
  inbound: "Inbound",
  addresses: "Addresses",
  providers: "Providers",
  exports: "Exports",
  suppressions: "Suppressions",
  recipients: "Recipients",
  lists: "Lists",
  confirm: "Subscriptions",
  unsubscribe: "Subscriptions",
  reputation: "Reputation",
  stats: "Stats",
  keys: "Keys",
  webhook_endpoints: "Webhook endpoints",
  activity: "Activity",
  organization: "Organization",
  "admin/providers": "Admin providers",
  "admin/domains": "Admin providers",
  "admin/organizations": "Admin organizations",
  "admin/users": "Admin users",
};

/** The reference section a route sits under. */
export function routeTag(route: Pick<RouteKey, "path">): string {
  const [, , first, second] = route.path.split("/");
  const tag = TAGS[first === "admin" ? `admin/${second}` : (first ?? "")];
  if (!tag) throw new Error(`${route.path} has no reference tag. Add one to TAGS in lib/api-docs/links.ts.`);
  return tag;
}

/** A route's page on the docs site. */
export function referenceUrl(route: RouteKey): string {
  return `${REFERENCE_URL}${routeTag(route).replace(/\s+/g, "-").toLowerCase()}/${operationId(route)}/`;
}
