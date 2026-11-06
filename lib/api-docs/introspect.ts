import { z } from "zod";

export interface ApiField {
  name: string;
  type: string;
  required: boolean;
  description: string;
  constraints: string[];
}

/** The slice of JSON Schema `z.toJSONSchema` emits that this adapter reads. */
interface JsonSchemaProp {
  type?: string;
  description?: string;
  enum?: unknown[];
  anyOf?: JsonSchemaProp[];
  items?: JsonSchemaProp;
  properties?: Record<string, JsonSchemaProp>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
  pattern?: string;
}

function typeLabel(prop: JsonSchemaProp): string {
  if (prop.enum) return prop.enum.map(String).join(" | ");
  if (prop.anyOf) return prop.anyOf.map(typeLabel).join(" or ");
  if (prop.type === "array") return `${prop.items ? typeLabel(prop.items) : "any"}[]`;
  if (prop.type === "integer") return "integer";
  return prop.type ?? "any";
}

function constraintsFor(prop: JsonSchemaProp): string[] {
  const out: string[] = [];
  if (prop.minLength !== undefined || prop.maxLength !== undefined) {
    out.push(`length ${prop.minLength ?? 0}–${prop.maxLength ?? "∞"}`);
  }
  if (prop.minimum !== undefined || prop.maximum !== undefined) {
    out.push(`${prop.minimum ?? "−∞"}–${prop.maximum ?? "∞"}`);
  }
  if (prop.minItems !== undefined || prop.maxItems !== undefined) {
    out.push(`${prop.minItems ?? 0}–${prop.maxItems ?? "∞"} items`);
  }
  if (prop.default !== undefined) out.push(`default ${JSON.stringify(prop.default)}`);
  if (prop.pattern) out.push("pattern-restricted");
  return out;
}

/**
 * Fails when a field, or a field nested inside an object/array-of-objects field, has no
 * `.describe()`. This is the enforcement docs/api/conventions.md promises: "A field without a
 * `.describe()` fails the docs build." Every schema in lib/schemas/ is walked by this at adapter
 * load, so a missing description throws before /openapi.json, llms.txt or the check script can
 * build — see api-docs.test.ts for the regression test.
 */
function assertDescribed(prop: JsonSchemaProp, path: string): void {
  if (!prop.description) {
    throw new Error(`${path} has no .describe() — every request field must be documented before the docs build passes.`);
  }
  const nestedProperties = prop.type === "array" ? prop.items?.properties : prop.properties;
  for (const [key, sub] of Object.entries(nestedProperties ?? {})) {
    assertDescribed(sub, `${path}.${key}`);
  }
}

/**
 * Walks a zod object schema (request input shape) into one documented row per top-level field.
 * Throws if any field, at any depth, is missing `.describe()`.
 */
export function fieldsFromSchema(schema: z.ZodType, schemaName: string): ApiField[] {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchemaProp & {
    properties?: Record<string, JsonSchemaProp>;
    required?: string[];
  };
  const properties = json.properties ?? {};
  const required = new Set(json.required ?? []);

  return Object.entries(properties).map(([name, prop]) => {
    assertDescribed(prop, `${schemaName}.${name}`);
    return {
      name,
      type: typeLabel(prop),
      required: required.has(name),
      description: prop.description as string,
      constraints: constraintsFor(prop),
    };
  });
}
