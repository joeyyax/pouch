import { sql } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";

/**
 * The database's clock, read once per operation.
 *
 * Every timestamp that a query later compares against another — `next_attempt_at`,
 * `backoff_until`, `locked_at` — comes from here. Writing one with the app's clock and
 * comparing it against Postgres `now()` makes "due" depend on the skew between two machines.
 *
 * Inside a transaction this is the transaction's own timestamp, the same instant `now()`
 * evaluates to in every statement of that transaction.
 */
export async function dbNow(executor: Executor = db): Promise<Date> {
  const rows = await executor.execute<{ now: Date }>(sql`select now() as now`);
  const value = rows[0]?.now;
  if (!value) throw new Error("The database returned no clock reading.");
  return value instanceof Date ? value : new Date(value);
}
