import postgres from "postgres";

/**
 * Refuses a second `vitest run` against this checkout's test database, which would otherwise
 * truncate the first run's rows mid-test. Held on its own connection; call the returned
 * function to release it.
 */
export async function acquireRunLock(adminUrl: string, database: string): Promise<() => Promise<void>> {
  const label = `pouch-tests pid ${process.pid} started ${new Date().toISOString()}`;
  const sql = postgres(adminUrl, { max: 1, connection: { application_name: label } });
  const key = lockKey(database);

  const [{ locked }] = await sql<[{ locked: boolean }]>`select pg_try_advisory_lock(0, ${key}) as locked`;
  if (!locked) {
    const [holder] = await sql<[{ application_name: string } | undefined]>`
      select a.application_name
      from pg_locks l
      join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and l.classid = 0 and l.objid = ${key} and l.objsubid = 2
    `;
    await sql.end({ timeout: 5 });
    throw new Error(
      `Another vitest run already owns the "${database}" test database` +
        (holder ? ` (${holder.application_name}).` : ".") +
        " Wait for it to finish, or run this suite from a different checkout.",
    );
  }

  return async () => {
    await sql`select pg_advisory_unlock(0, ${key})`;
    await sql.end({ timeout: 5 });
  };
}

/** A 32-bit key so it fits `pg_try_advisory_lock`'s two-int form and stays easy to query back. */
function lockKey(database: string): number {
  let hash = 0;
  for (let i = 0; i < database.length; i++) {
    hash = (hash * 31 + database.charCodeAt(i)) | 0;
  }
  return hash;
}
