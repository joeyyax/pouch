import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

export interface KeysetOrder {
  table: PgTable;
  /** The timestamp the list sorts on. */
  sort: AnyPgColumn;
  /** The tiebreaker, and what a cursor names. */
  id: AnyPgColumn;
}

/**
 * Rows past the cursor row in `(sort, id)` order. The cursor's timestamp is read in SQL, since a
 * JS Date drops the microseconds rows written in one statement or transaction share.
 */
function keyset(order: KeysetOrder, cursorId: string, operator: "<" | ">"): SQL {
  const { table, sort, id } = order;
  return sql`(${sort}, ${id}) ${sql.raw(operator)} (select ${sort}, ${id} from ${table} where ${id} = ${cursorId})`;
}

/** For a newest-first list: rows older than the cursor row. */
export function keysetBefore(order: KeysetOrder, cursorId: string): SQL {
  return keyset(order, cursorId, "<");
}

/** For an oldest-first list: rows newer than the cursor row. */
export function keysetAfter(order: KeysetOrder, cursorId: string): SQL {
  return keyset(order, cursorId, ">");
}
