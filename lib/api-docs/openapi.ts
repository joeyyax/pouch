/** The OpenAPI 3.1 document, from the same route spec as llms.txt and MCP. */
import { z } from "zod";
import { brand } from "@/lib/brand";
import { ERROR_CODES, type ErrorCode } from "@/lib/api/errors";
import { DOCS_URL, operationId, routeTag } from "./links";
import { BODY_CODES, CODES, GLOBAL_CODES, ROUTES, type ResponseField, type RouteSpec } from "./spec";

type Schema = Record<string, unknown>;

function jsonSchema(schema: z.ZodType): Schema {
  const { $schema: _, ...out } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Schema;
  return out;
}

const BASE_TYPES = new Set(["string", "integer", "number", "boolean", "object", "null"]);

/** Splits on `sep` outside braces and parentheses. */
function splitTop(value: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "{" || char === "(") depth++;
    if (char === "}" || char === ")") depth--;
    if (depth === 0 && value.startsWith(sep, i)) {
      out.push(current.trim());
      current = "";
      i += sep.length - 1;
    } else current += char;
  }
  out.push(current.trim());
  return out;
}

/** Reads the type labels response fields carry: `string | null`, `a | b`, `{ id, name }[]`, `Domain[]`. */
function labelSchema(label: string): Schema | null {
  const parts = splitTop(label, " | ").filter((part) => part !== "undefined");
  if (parts.length > 1) {
    const nullable = parts.includes("null");
    const rest = parts.filter((part) => part !== "null");
    if (rest.every((part) => /^[a-z][a-z0-9_.]*$/.test(part) && !BASE_TYPES.has(part))) {
      return nullable ? { type: ["string", "null"], enum: [...rest, null] } : { type: "string", enum: rest };
    }
    const options = rest.map(labelSchema);
    if (options.some((option) => option === null)) return null;
    const all = nullable ? [...(options as Schema[]), { type: "null" }] : (options as Schema[]);
    return all.length === 1 ? all[0]! : { anyOf: all };
  }
  const part = parts[0] ?? "";
  if (part === "true") return { type: "boolean", const: true };
  if (BASE_TYPES.has(part)) return { type: part };
  if (part.endsWith("[]")) {
    const items = labelSchema(part.slice(0, -2).replace(/^\((.*)\)$/, "$1"));
    return items ? { type: "array", items } : { type: "array" };
  }
  if (/^[A-Z]\w*$/.test(part)) return { type: "object", title: part };
  if (part.startsWith("{") && part.endsWith("}")) {
    const properties: Record<string, Schema> = {};
    for (const entry of splitTop(part.slice(1, -1).trim(), ",")) {
      const [name, ...type] = splitTop(entry, ":");
      if (!name || !/^\w+$/.test(name)) return { type: "object" };
      properties[name] = type.length > 0 ? (labelSchema(type.join(":")) ?? {}) : {};
    }
    return { type: "object", properties };
  }
  if (/^[a-z][a-z0-9_.]*$/.test(part)) return { type: "string", const: part };
  return null;
}

function responseSchema(fields: ResponseField[]): Schema {
  const properties: Record<string, Schema> = {};
  for (const field of fields) {
    properties[field.name] = { ...(labelSchema(field.type) ?? {}), description: field.description };
  }
  return { type: "object", properties };
}

function pathParams(path: string): Schema[] {
  return [...path.matchAll(/:(\w+)/g)].map(([, name]) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
    description: name === "address" ? "An email address." : "An opaque, type-prefixed id.",
  }));
}

function queryParams(route: RouteSpec): Schema[] {
  if (!route.query) return [];
  const schema = jsonSchema(route.query.schema) as { properties?: Record<string, Schema>; required?: string[] };
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, property]) => {
    const { description, ...rest } = property;
    return { name, in: "query", required: required.has(name), description, schema: rest };
  });
}

function errorResponses(route: RouteSpec): Record<string, Schema> {
  const codes = [...new Set<ErrorCode>([...route.errors, ...GLOBAL_CODES, ...(route.request ? BODY_CODES : [])])];
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) byStatus.set(ERROR_CODES[code], [...(byStatus.get(ERROR_CODES[code]) ?? []), code]);
  const out: Record<string, Schema> = {};
  for (const [status, list] of [...byStatus].sort(([a], [b]) => a - b)) {
    out[String(status)] = {
      description: list.map((code) => `\`${code}\`: ${CODES[code].when}`).join("\n\n"),
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    };
  }
  return out;
}

function operation(route: RouteSpec): Schema {
  const open = route.auth.startsWith("None");
  const description = [`Auth: ${route.auth}.`, route.request?.note].filter(Boolean).join("\n\n");
  return {
    operationId: operationId(route),
    summary: route.summary,
    description,
    tags: [routeTag(route)],
    ...(open ? { security: [] } : {}),
    parameters: [...pathParams(route.path), ...queryParams(route)],
    ...(route.request
      ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(route.request.schema) } } } }
      : {}),
    responses: {
      [String(route.response.status)]: {
        description: [route.response.description, route.response.note].filter(Boolean).join(" "),
        content: { "application/json": { schema: responseSchema(route.response.fields) } },
      },
      ...errorResponses(route),
    },
  };
}

/** `servers` is the install's own URL when it has one, or a variable the reader fills in. */
export function openApiDocument(serverUrl?: string): Schema {
  const paths: Record<string, Record<string, Schema>> = {};
  for (const route of ROUTES) {
    const path = route.path.replace(/:(\w+)/g, "{$1}");
    (paths[path] ??= {})[route.method.toLowerCase()] = operation(route);
  }
  const tags = [...new Set(ROUTES.map(routeTag))].map((name) => ({ name }));
  return {
    openapi: "3.1.1",
    info: {
      title: `${brand.name} API`,
      version: "v1",
      description: `Every endpoint ${brand.name} serves under /v1, generated from the zod schemas that validate requests.`,
      license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
    },
    servers: serverUrl
      ? [{ url: serverUrl }]
      : [
          {
            url: "{baseUrl}",
            description: "Your install's APP_URL",
            variables: { baseUrl: { default: "https://pouch.example.com", description: "Your install's APP_URL." } },
          },
        ],
    externalDocs: { url: DOCS_URL },
    tags,
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "An API key in the Authorization header." },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", enum: Object.keys(ERROR_CODES), description: "Stable. Callers branch on it." },
                message: { type: "string", description: "One sentence. Can change." },
                field: { type: "string", description: "The field a validation error is about." },
                detail: { type: "object", description: "More about the error, per code." },
                request_id: { type: "string", description: "The X-Request-Id of the request." },
              },
            },
          },
        },
      },
    },
  };
}
