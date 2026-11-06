/** llms.txt and llms-full.txt, from the same route spec as /reference. */
import { brand } from "@/lib/brand";
import { ERROR_CODES } from "@/lib/api/errors";
import type { ApiField } from "./introspect";
import { BODY_CODES, CODES, GLOBAL_CODES, ROUTES, routeAnchor, type ResponseField, type RouteSpec } from "./spec";

function basics(base: string): string {
  return [
    `# ${brand.name}`,
    "",
    `> Transactional email API with a provider-agnostic core. One key and one endpoint send mail; the delivery provider is a detail of the domain.`,
    "",
    `- Base URL: ${base}/v1. JSON in, JSON out.`,
    "- Auth: `Authorization: Bearer <key>` on every request.",
    "- Ids are opaque and type-prefixed (`dom_`, `msg_`).",
    "- Lists take `limit` (default 50, max 200) and `cursor`, and return `data` and `next_cursor`, newest first.",
    `- Errors are \`{ "error": { "code", "message", "request_id" } }\`. ${GLOBAL_CODES.map((code) => `\`${code}\``).join(", ")} can come from any route.`,
    `- MCP: ${base}/mcp, streamable HTTP, the same bearer key. Each tool wraps a /v1 route.`,
  ].join("\n");
}

function routeLine(base: string, route: RouteSpec): string {
  return `- [${route.method} ${route.path}](${base}/reference#${routeAnchor(route)}): ${route.summary}`;
}

export function llmsIndex(base: string): string {
  return [
    basics(base),
    "",
    "## Docs",
    "",
    `- [API reference](${base}/reference): every endpoint, field and error, generated from the request schemas`,
    `- [Full reference as text](${base}/llms-full.txt): the same, in one file`,
    "",
    "## Endpoints",
    "",
    ...ROUTES.map((route) => routeLine(base, route)),
    "",
  ].join("\n");
}

function requestFields(fields: ApiField[]): string[] {
  return fields.map((field) => {
    const extra = [field.required ? "required" : "optional", ...field.constraints].join(", ");
    return `- \`${field.name}\` (${field.type}; ${extra}): ${field.description}`;
  });
}

function responseFields(fields: ResponseField[]): string[] {
  return fields.map((field) => `- \`${field.name}\` (${field.type}): ${field.description}`);
}

function routeSection(route: RouteSpec): string[] {
  return [
    `### ${route.method} ${route.path}`,
    "",
    route.summary,
    "",
    `Auth: ${route.auth}`,
    ...(route.request ? ["", "Request body:", ...(route.request.note ? [route.request.note] : []), ...requestFields(route.request.fields)] : []),
    ...(route.query ? ["", "Query:", ...requestFields(route.query.fields)] : []),
    "",
    `Response ${route.response.status}: ${route.response.description}${route.response.note ? ` ${route.response.note}` : ""}`,
    ...responseFields(route.response.fields),
    ...(route.errors.length > 0 ? ["", `Errors: ${route.errors.map((code) => `\`${code}\``).join(", ")}`] : []),
    "",
  ];
}

export function llmsFull(base: string): string {
  return [
    basics(base),
    `- A route that reads a JSON body can also return ${BODY_CODES.map((code) => `\`${code}\``).join(" or ")}.`,
    "",
    "## Endpoints",
    "",
    ...ROUTES.flatMap(routeSection),
    "## Error codes",
    "",
    ...Object.keys(ERROR_CODES).map((code) => `- \`${code}\` (${ERROR_CODES[code as keyof typeof ERROR_CODES]}): ${CODES[code as keyof typeof CODES].when}`),
    "",
  ].join("\n");
}
