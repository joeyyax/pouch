/**
 * Applies pending migrations from `drizzle/`.
 *
 * Same migrator drizzle-kit runs, on our own connection so `onnotice` can be silenced:
 * its CLI prints Postgres NOTICEs that look identical to a real failure.
 */
import "@/lib/env";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Fixed key for the migrator's own advisory lock. Distinct from the per-checkout run lock in
 * `tests/database-lock.ts`, which guards a test database rather than a migration.
 */
export const MIGRATION_LOCK_KEY = 891_374_650;

/** How long a migration statement waits on a table lock before the run fails. */
export const MIGRATION_LOCK_TIMEOUT = "10s";

export async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL isn't set.");

  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client);

  try {
    // Blocks until any other container's migrator releases the lock, so two containers
    // booting at once apply the schema once instead of racing. Released explicitly below
    // rather than left to session end, since this connection is reused for the migration.
    await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    // Set after the advisory lock, which waits as long as another migrator runs.
    await client`select set_config('lock_timeout', ${MIGRATION_LOCK_TIMEOUT}, false)`;
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("migrations applied successfully");
  } finally {
    await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("migration failed:", error);
    process.exit(1);
  });
}
