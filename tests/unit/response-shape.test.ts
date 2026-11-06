import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";
import { defineShape, project, selectShape, shapeQuery, shapeToolArgs } from "@/lib/api/shape";
import { ROUTES } from "@/lib/api-docs/spec";
import { ROUTE_SHAPES, UNSHAPED } from "@/lib/api-docs/shapes";
import { keyShape, memberShape } from "@/lib/schemas/shapes";
import { MCP_TOOLS } from "@/lib/mcp/registry";
import { listMessagesSchema, messageListShape, messageReadShape } from "@/lib/schemas/message";
import { shapeQuerySchema } from "@/lib/api/shape";
import { validationError } from "@/lib/schemas/validation-error";
import { signMessageDownload, verifyMessageDownload } from "@/lib/messages/downloads";

const shape = defineShape({
  resource: "thing",
  keys: ["id", "name", "size", "events", "body", "body_unavailable"],
  defaults: ["id", "name", "size", "events"],
  expansions: {
    events: { keys: ["events"], description: "history" },
    body: { keys: ["body", "body_unavailable"], description: "content" },
  },
});

const sorted = (set: ReadonlySet<string>) => [...set].sort();

describe("selectShape", () => {
  it("returns the defaults when the request names nothing", () => {
    expect(sorted(selectShape(shape).keys)).toEqual(["events", "id", "name", "size"]);
    expect(sorted(selectShape(shape).expansions)).toEqual(["events"]);
  });

  it("replaces the defaults with fields, and keeps id", () => {
    const selection = selectShape(shape, { fields: ["name"] });
    expect(sorted(selection.keys)).toEqual(["id", "name"]);
    expect(selection.expands("events")).toBe(false);
  });

  it("adds an expansion's keys on top of the defaults", () => {
    const selection = selectShape(shape, { include: ["body"] });
    expect(sorted(selection.keys)).toEqual(["body", "body_unavailable", "events", "id", "name", "size"]);
    expect(selection.expands("body")).toBe(true);
  });

  it("takes a whole expansion when fields names one of its keys", () => {
    const selection = selectShape(shape, { fields: ["body"] });
    expect(sorted(selection.keys)).toEqual(["body", "body_unavailable", "id"]);
    expect(selection.expands("body")).toBe(true);
  });

  it("combines fields and include", () => {
    expect(sorted(selectShape(shape, { fields: ["name"], include: ["events"] }).keys)).toEqual(["events", "id", "name"]);
  });
});

describe("project", () => {
  it("keeps the selected keys in the value's own order", () => {
    const value = { id: "t_1", name: "n", size: 3, events: [], body: null, body_unavailable: null };
    expect(Object.keys(project(value, selectShape(shape, { fields: ["size", "name"] })))).toEqual(["id", "name", "size"]);
  });
});

describe("defineShape", () => {
  it("refuses a shape without id", () => {
    expect(() => defineShape({ resource: "x", keys: ["name"], defaults: ["name"], expansions: {} })).toThrow(/id key/);
  });

  it("refuses a default or expansion key it doesn't declare", () => {
    expect(() =>
      defineShape({ resource: "x", keys: ["id"], defaults: ["id"], expansions: { body: { keys: ["body" as "id"], description: "" } } }),
    ).toThrow(/undeclared keys body/);
  });
});

describe("shapeQuery", () => {
  const schema = z.object(shapeQuery(shape));

  it("splits, trims and dedupes a comma-separated list", () => {
    expect(schema.parse({ include: "body, events,body", fields: "name" })).toEqual({ include: ["body", "events"], fields: ["name"] });
  });

  it("reads an empty list as absent", () => {
    expect(schema.parse({ include: "", fields: " , " })).toEqual({ include: undefined, fields: undefined });
  });

  it.each([
    ["include", { include: "body,facts" }, "facts", ["events", "body"]],
    ["fields", { fields: "name,colour" }, "colour", ["id", "name", "size", "events", "body", "body_unavailable"]],
  ])("refuses an unknown %s name with validation_failed, naming the valid values", (param, query, unknown, valid) => {
    let caught: unknown;
    try {
      schema.parse(query);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZodError);
    const body = validationError(caught as ZodError, query).toBody().error;
    expect(body.code).toBe("validation_failed");
    expect(body.field).toBe(param);
    expect(body.message).toContain(`"${unknown}"`);
    expect(body.message).toContain(valid.join(", "));
    expect(body.detail).toEqual({ unknown: [unknown], valid });
  });

  it("describes every valid name for the docs", () => {
    const { include, fields } = shapeQuery(shape);
    expect(include.description).toContain("events (history, returned by default)");
    expect(include.description).toContain("body (content)");
    expect(fields.description).toContain("id, name, size, events, body, body_unavailable");
  });
});

describe("shapeToolArgs", () => {
  const args = z.object(shapeToolArgs(shape));

  it("takes arrays of valid names and refuses others", () => {
    expect(args.parse({ include: ["body"], fields: ["name"] })).toEqual({ include: ["body"], fields: ["name"] });
    expect(() => args.parse({ include: ["facts"] })).toThrow();
  });

  it("serializes to the comma-separated form the route parses", () => {
    expect(String(["body", "events"])).toBe("body,events");
  });
});

describe("the route declarations", () => {
  const key = (route: { method: string; path: string }) => `${route.method} ${route.path}`;
  const gets = ROUTES.filter((route) => route.method === "GET");

  it("give every GET route a shape or a reason it has none, and nothing stale", () => {
    const missing = gets.map(key).filter((route) => !(route in ROUTE_SHAPES) && !(route in UNSHAPED));
    expect(missing).toEqual([]);
    const documented = new Set(gets.map(key));
    expect([...Object.keys(ROUTE_SHAPES), ...Object.keys(UNSHAPED)].filter((route) => !documented.has(route))).toEqual([]);
    expect(Object.keys(ROUTE_SHAPES).filter((route) => route in UNSHAPED)).toEqual([]);
  });

  it("declare every key a single read documents, and no other", () => {
    for (const route of gets) {
      const shape = ROUTE_SHAPES[key(route)];
      const names = route.response.fields.map((field) => field.name);
      if (!shape || names.includes("data")) continue;
      expect([...shape.keys].sort(), key(route)).toEqual(names.sort());
    }
  });

  it("document fields on every shaped route, and include only where there's an expansion", () => {
    for (const route of gets) {
      const shape = ROUTE_SHAPES[key(route)];
      if (!shape) continue;
      const params = route.query!.fields.map((field) => field.name);
      expect(params, key(route)).toContain("fields");
      expect(params.includes("include"), key(route)).toBe(Object.keys(shape.expansions).length > 0);
      expect(route.errors, key(route)).toContain("validation_failed");
    }
  });

  it("give the MCP tools over those routes the same names as arrays", () => {
    const shaped = MCP_TOOLS.filter((tool) => key(tool.route) in ROUTE_SHAPES);
    expect(shaped.length).toBeGreaterThan(30);
    for (const tool of shaped) {
      const shape = ROUTE_SHAPES[key(tool.route)]!;
      expect(tool.payload, tool.name).toBe("query");
      const json = z.toJSONSchema(tool.inputSchema, { io: "input", unrepresentable: "any" }) as { properties: Record<string, { type?: string }> };
      expect(json.properties.fields?.type, tool.name).toBe("array");
      expect(json.properties.include?.type, tool.name).toBe(Object.keys(shape.expansions).length > 0 ? "array" : undefined);
    }
  });

  it("parse the list and read queries", () => {
    expect(listMessagesSchema.parse({ include: "events" }).include).toEqual(["events"]);
    expect(() => listMessagesSchema.parse({ include: "stall" })).toThrow();
    expect(shapeQuerySchema(messageReadShape).parse({ include: "stall,body" }).include).toEqual(["stall", "body"]);
    expect(messageListShape.defaults).not.toContain("events");
    expect(shapeQuerySchema(keyShape).shape).not.toHaveProperty("include");
  });

  it("keep a resource's own id key", () => {
    expect([...selectShape(memberShape, { fields: ["email"] }).keys].sort()).toEqual(["email", "user_id"]);
  });
});

describe("message download tokens", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const later = new Date(now.getTime() + 900_000);

  it("round-trips, and refuses one that's expired or pointed elsewhere", () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-value";
    const token = signMessageDownload("msg_abc", 1, later);
    expect(verifyMessageDownload(token, now)).toEqual({ messageId: "msg_abc", index: 1 });
    expect(verifyMessageDownload(token, new Date(later.getTime() + 1000))).toBeNull();
    const [, index, expiry, signature] = token.split(".");
    expect(verifyMessageDownload(`msg_other.${index}.${expiry}.${signature}`, now)).toBeNull();
    expect(verifyMessageDownload(`msg_abc.0.${expiry}.${signature}`, now)).toBeNull();
  });
});
