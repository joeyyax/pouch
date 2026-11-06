import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** Single-quoted SQL literal. Values come from our own `as const` arrays, never user input. */
function literal(value: string): SQL {
  return sql.raw(`'${value.replace(/'/g, "''")}'`);
}

/** `column in (...)`, generated from the same values the app treats as the enum. */
export function enumCheck(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sql.join(values.map(literal), sql.raw(", "))})`;
}

/** Same as `enumCheck`, but lets the column stay null. */
export function nullableEnumCheck(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} is null or ${enumCheck(column, values)}`;
}

/** `column <@ array[...]`, for a text[] column whose members must each be one of `values`. */
export function enumArrayCheck(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} <@ array[${sql.join(values.map(literal), sql.raw(", "))}]::text[]`;
}
