import { z, ZodError } from "zod";
import { validationError } from "@/lib/schemas/validation-error";

/** A part of a response loaded on its own: the top-level keys it adds and what it is. */
export interface Expansion<K extends string> {
  keys: readonly K[];
  description: string;
}

/**
 * What one route's response can carry. `keys` is every top-level key, in response order;
 * `defaults` is what a request naming neither `fields` nor `include` gets.
 */
export interface ResponseShape<K extends string = string, X extends string = string> {
  resource: string;
  /** The key that names an item, always returned. `id` unless the resource has none. */
  idKey?: K;
  keys: readonly K[];
  defaults: readonly K[];
  expansions: Readonly<Record<X, Expansion<K>>>;
}

export function idKeyOf(shape: ResponseShape): string {
  return shape.idKey ?? "id";
}

/** Checks a declaration once, at import: the id key is a key, and every default and expansion key is declared. */
export function defineShape<const K extends string, const X extends string = never>(shape: ResponseShape<K, X>): ResponseShape<K, X> {
  const known = new Set<string>(shape.keys);
  if (!known.has(idKeyOf(shape))) throw new Error(`${shape.resource}: a response shape needs an ${idKeyOf(shape)} key.`);
  const stray = [...shape.defaults, ...Object.values<Expansion<K>>(shape.expansions).flatMap((expansion) => expansion.keys)].filter(
    (key) => !known.has(key),
  );
  if (stray.length > 0) throw new Error(`${shape.resource}: undeclared keys ${stray.join(", ")}.`);
  return shape;
}

export function expansionNames<X extends string>(shape: ResponseShape<string, X>): X[] {
  return Object.keys(shape.expansions) as X[];
}

/** The keys a request asked for, and the expansions that have to be loaded to fill them. */
export interface Selection<K extends string = string, X extends string = string> {
  keys: ReadonlySet<K>;
  expansions: ReadonlySet<X>;
  has(key: K): boolean;
  expands(expansion: X): boolean;
}

export interface ShapeRequest {
  include?: readonly string[] | undefined;
  fields?: readonly string[] | undefined;
}

/**
 * `fields` replaces the defaults, `include` adds to them, and the id key always comes back. Naming
 * any key an expansion adds selects the whole expansion. Names are assumed valid; the query schema checks them.
 */
export function selectShape<K extends string, X extends string>(shape: ResponseShape<K, X>, request: ShapeRequest = {}): Selection<K, X> {
  const keys = new Set<K>([idKeyOf(shape) as K, ...((request.fields as K[] | undefined) ?? shape.defaults)]);
  const expansions = new Set<X>(request.include as X[] | undefined);
  for (const [name, expansion] of Object.entries<Expansion<K>>(shape.expansions)) {
    if (expansion.keys.some((key) => keys.has(key))) expansions.add(name as X);
  }
  for (const name of expansions) for (const key of shape.expansions[name].keys) keys.add(key);
  return { keys, expansions, has: (key) => keys.has(key), expands: (name) => expansions.has(name) };
}

/** Every key the selection holds, in the order `value` carries them. Keys the selection names but `value` lacks stay absent. */
export function project<T extends object>(value: T, selection: Selection): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => selection.keys.has(key))) as Partial<T>;
}

/** A page with each item projected. */
export function projectPage<T extends object, P extends { data: T[] }>(page: P, selection: Selection): Omit<P, "data"> & { data: Partial<T>[] } {
  return { ...page, data: page.data.map((item) => project(item, selection)) };
}

function splitList(raw: string): string[] {
  return [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
}

function listParam(name: "include" | "fields", valid: readonly string[], description: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return undefined;
      const names = splitList(raw);
      if (names.length === 0) return undefined;
      const unknown = names.filter((value) => !valid.includes(value));
      if (unknown.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown ${name} ${unknown.map((value) => `"${value}"`).join(", ")}. Valid values: ${valid.join(", ")}.`,
          params: { unknown, valid: [...valid] },
        });
        return z.NEVER;
      }
      return names;
    })
    .describe(description);
}

function includeDescription(shape: ResponseShape): string {
  const listed = expansionNames(shape).map((name) => {
    const expansion = shape.expansions[name]!;
    const on = expansion.keys.every((key) => shape.defaults.includes(key)) ? ", returned by default" : "";
    return `${name} (${expansion.description}${on})`;
  });
  return `Comma-separated expansions to add: ${listed.join("; ")}.`;
}

function fieldsDescription(shape: ResponseShape): string {
  return `Comma-separated top-level keys to return in place of the defaults. ${idKeyOf(shape)} always comes back. Valid: ${shape.keys.join(", ")}.`;
}

type ListParam = ReturnType<typeof listParam>;

/** `{ fields }`, plus `include` when the shape has expansions. */
type WithInclude<X extends string, P> = [X] extends [never] ? { fields: P } : { include: P; fields: P };

/** `include` and `fields` as comma-separated query parameters, for a route's zod query schema. A shape without expansions takes no `include`. */
export function shapeQuery<X extends string>(shape: ResponseShape<string, X>): WithInclude<X, ListParam> {
  const fields = listParam("fields", shape.keys, fieldsDescription(shape));
  if (expansionNames(shape).length === 0) return { fields } as WithInclude<X, ListParam>;
  return { include: listParam("include", expansionNames(shape), includeDescription(shape)), fields } as WithInclude<X, ListParam>;
}

/** The query schema of a read that takes nothing but `include` and `fields`. */
export function shapeQuerySchema(shape: ResponseShape) {
  return z.object(shapeQuery(shape));
}

/** Parses `include` and `fields` off a read's URL, or throws `validation_failed`. */
export function readSelection<K extends string, X extends string>(request: Request, shape: ResponseShape<K, X>): Selection<K, X> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    return selectShape(shape, shapeQuerySchema(shape).parse(query) as ShapeRequest);
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, query);
    throw error;
  }
}

type ToolList = z.ZodOptional<z.ZodArray<z.ZodEnum<Record<string, string>>>>;

/** `include` and `fields` as arrays of their valid names, for an MCP tool's input schema. */
export function shapeToolArgs<X extends string>(shape: ResponseShape<string, X>): WithInclude<X, ToolList> {
  const names = expansionNames(shape);
  const fields = z
    .array(z.enum(shape.keys as [string, ...string[]]))
    .optional()
    .describe(fieldsDescription(shape).replace("Comma-separated top-level keys", "Top-level keys"));
  if (names.length === 0) return { fields } as WithInclude<X, ToolList>;
  const include = z
    .array(z.enum(names as unknown as [string, ...string[]]))
    .optional()
    .describe(includeDescription(shape).replace("Comma-separated expansions", "Expansions"));
  return { include, fields } as WithInclude<X, ToolList>;
}
