import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type Database = ReturnType<typeof drizzle<typeof schema>>;

/** The connection or the open transaction. Writes that must land together take one of these. */
export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

let instance: Database | null = null;
let client: ReturnType<typeof postgres> | null = null;

function connect(): Database {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL isn't set.");
    // One pool per test file against a shared Postgres starves the suite: 183 files × 10
    // connections over a 100-connection server stalls on connect, not on work.
    const max = Number(process.env.DATABASE_POOL_MAX ?? (process.env.VITEST ? 3 : 10));
    client = postgres(url, { max, idle_timeout: 30, connect_timeout: 10, onnotice: () => {} });
    instance = drizzle(client, { schema });
  }
  return instance;
}

export const db = new Proxy({} as Database, {
  get(_target, prop) {
    return (connect() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export async function closeDb(): Promise<void> {
  if (!client) return;
  await client.end({ timeout: 5 });
  client = null;
  instance = null;
}

export async function pingDb(timeoutMs = 1500): Promise<boolean> {
  const probe = db.execute(sql`select 1`);
  const timer = new Promise<never>((_resolve, reject) =>
    setTimeout(() => reject(new Error("timeout")), timeoutMs).unref(),
  );
  try {
    await Promise.race([probe, timer]);
    return true;
  } catch {
    return false;
  }
}

export { schema };
