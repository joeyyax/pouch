import { z } from "zod";
import { describe, expect, it } from "vitest";
import { fieldsFromSchema } from "@/lib/api-docs/introspect";
import { ROUTES } from "@/lib/api-docs/spec";

describe("fieldsFromSchema", () => {
  it("rejects a field with no .describe()", () => {
    const fixture = z.object({
      documented: z.string().describe("This one has a description."),
      undocumented: z.string(),
    });

    expect(() => fieldsFromSchema(fixture, "fixture")).toThrow(/undocumented.*\.describe\(\)/);
  });

  it("rejects a nested object field with no .describe()", () => {
    const fixture = z.object({
      items: z
        .array(
          z.object({
            name: z.string().describe("Documented."),
            value: z.string(),
          }),
        )
        .describe("The array field itself is documented."),
    });

    expect(() => fieldsFromSchema(fixture, "fixture")).toThrow(/items\.value.*\.describe\(\)/);
  });

  it("accepts a schema where every field is described", () => {
    const fixture = z.object({
      name: z.string().min(1).max(10).describe("A name."),
      count: z.number().optional().describe("A count."),
    });

    const fields = fieldsFromSchema(fixture, "fixture");
    expect(fields).toHaveLength(2);
    expect(fields.find((f) => f.name === "name")).toMatchObject({
      required: true,
      description: "A name.",
      type: "string",
    });
    expect(fields.find((f) => f.name === "count")).toMatchObject({ required: false });
  });
});

describe("the live route spec", () => {
  it("documents every route with at least one error code and a response shape", () => {
    expect(ROUTES.length).toBeGreaterThan(0);
    for (const route of ROUTES) {
      expect(route.errors.length).toBeGreaterThan(0);
      expect(route.response.fields.length).toBeGreaterThan(0);
    }
  });

  it("gives every request and query field on the live schemas a real description", () => {
    for (const route of ROUTES) {
      for (const field of [...(route.request?.fields ?? []), ...(route.query?.fields ?? [])]) {
        expect(field.description.length).toBeGreaterThan(0);
      }
    }
  });
});
