import { sql } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";

/** Thrown to roll the transaction back once the body is done. Never escapes `withSchema`. */
class Rollback extends Error {}

/**
 * Runs `body` with `ddl` applied, inside a transaction that always rolls back.
 *
 * A migration replay has to stand the schema back up as it was before the migration ran, and
 * that schema can't outlive the test: a body that throws part way used to leave the database
 * without its constraints for every later run in the checkout (#397). Assertions belong inside
 * the body, since the state they read is gone once this returns.
 */
export async function withSchema<T>(ddl: string[], body: (tx: Executor) => Promise<T>): Promise<T> {
  let result: T;
  try {
    await db.transaction(async (tx) => {
      for (const statement of ddl) await tx.execute(sql.raw(statement));
      result = await body(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result!;
}
