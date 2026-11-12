import { describe, expect, it } from "vitest";
import { openApiDocument } from "@/lib/api-docs/openapi";
import { operationId, referenceUrl } from "@/lib/api-docs/links";
import { ROUTES } from "@/lib/api-docs/spec";
import { handlerKey as key, servedRoutes } from "./served-routes";
import { GET } from "@/app/openapi.json/route";

interface Operation {
  operationId: string;
  parameters: { name: string; in: string }[];
  requestBody?: { content: { "application/json": { schema: { type?: string } } } };
  responses: Record<string, unknown>;
}

type Schema = Record<string, unknown>;

const document = openApiDocument() as {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

function resolve(schema: Schema | undefined): Schema | undefined {
  const ref = schema?.$ref as string | undefined;
  return ref ? document.components.schemas[ref.replace("#/components/schemas/", "")] : schema;
}

const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({
    method: method.toUpperCase(),
    path: path.replace(/\{(\w+)\}/g, ":$1"),
    operation,
  })),
);

/** Every 2xx response schema, by route. */
const successSchemas = operations.flatMap(({ method, path, operation }) =>
  Object.entries(operation.responses as Record<string, { content?: Record<string, { schema: Schema }> }>)
    .filter(([status]) => Number(status) < 300)
    .map(([, response]) => ({ route: `${method} ${path}`, schema: response.content?.["application/json"]?.schema })),
);

describe("/openapi.json", () => {
  it("is OpenAPI 3.1", () => {
    expect(document.openapi).toMatch(/^3\.1\./);
  });

  it("has an operation for every route the registry declares, and nothing else", () => {
    expect(operations.map(key).sort()).toEqual(ROUTES.map(key).sort());
  });

  it("has an operation for every route the service serves", () => {
    const have = new Set(operations.map(key));
    expect(servedRoutes().filter((h) => !have.has(key(h))).map(key)).toEqual([]);
  });

  it("carries each route's query fields, request body and statuses", () => {
    for (const route of ROUTES) {
      const operation = operations.find((o) => key(o) === key(route))!.operation;
      expect(operation.operationId).toBe(operationId(route));
      const query = operation.parameters.filter((p) => p.in === "query").map((p) => p.name);
      expect(query, key(route)).toEqual((route.query?.fields ?? []).map((f) => f.name));
      expect(Boolean(operation.requestBody), key(route)).toBe(Boolean(route.request));
      expect(Object.keys(operation.responses), key(route)).toContain(String(route.response.status));
    }
  });

  it("types every response property, nested ones included", () => {
    const untyped: string[] = [];
    const walk = (raw: Schema | undefined, path: string, seen: Set<Schema>) => {
      const schema = resolve(raw);
      if (!schema || seen.has(schema)) return;
      seen.add(schema);
      for (const [name, property] of Object.entries((schema.properties ?? {}) as Record<string, Schema>)) {
        if (!("type" in property) && !("anyOf" in property) && !("$ref" in property)) untyped.push(`${path}.${name}`);
        walk(property, `${path}.${name}`, seen);
      }
      walk(schema.items as Schema | undefined, `${path}[]`, seen);
      for (const option of (schema.anyOf ?? []) as Schema[]) walk(option, path, seen);
    };
    for (const { route, schema } of successSchemas) walk(schema, route, new Set());
    expect(untyped).toEqual([]);
  });

  it("describes every list item's properties", () => {
    const empty: string[] = [];
    for (const { route, schema } of successSchemas) {
      const data = (schema?.properties as Record<string, Schema> | undefined)?.data;
      if (data?.type !== "array") continue;
      const item = resolve(data.items as Schema);
      if (!item || Object.keys((item.properties ?? {}) as Schema).length === 0) empty.push(route);
    }
    expect(empty).toEqual([]);
  });

  it("resolves every component reference", () => {
    const refs = [...JSON.stringify(document).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map(([, name]) => name!);
    expect(refs.filter((name) => !(name in document.components.schemas))).toEqual([]);
  });

  it("names a docs page for every route", () => {
    for (const route of ROUTES) expect(referenceUrl(route)).toMatch(/^https:\/\/pouch\.email\/docs\/reference\/[a-z-]+\/[a-z0-9-]+\/$/);
  });

  it("serves the install's own URL", async () => {
    const body = (await GET().json()) as { servers: { url: string }[] };
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]!.url).not.toContain("{");
  });
});
