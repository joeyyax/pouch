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

const document = openApiDocument() as { openapi: string; paths: Record<string, Record<string, Operation>> };
const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({
    method: method.toUpperCase(),
    path: path.replace(/\{(\w+)\}/g, ":$1"),
    operation,
  })),
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

  it("names a docs page for every route", () => {
    for (const route of ROUTES) expect(referenceUrl(route)).toMatch(/^https:\/\/pouch\.email\/docs\/reference\/[a-z-]+\/[a-z0-9-]+\/$/);
  });

  it("serves the install's own URL", async () => {
    const body = (await GET().json()) as { servers: { url: string }[] };
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]!.url).not.toContain("{");
  });
});
