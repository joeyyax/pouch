import { execFile } from "node:child_process";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `scripts/migrate.ts` takes an advisory lock before migrating, so two containers booting at
 * once against one database don't race the migrator. Both tests here spawn the real script as
 * a child process — the same command production runs (`node --import tsx scripts/migrate.ts`) —
 * rather than calling its internals, so a genuinely separate connection and session are under test.
 *
 * Must match `MIGRATION_LOCK_KEY` in scripts/migrate.ts. Kept independent (not imported) so
 * this test exercises the lock the script actually takes, not whatever a shared constant says.
 */
const MIGRATION_LOCK_KEY = 891_374_650;

let adminSql: postgres.Sql;
const scratchDatabases: string[] = [];

beforeAll(() => {
  const base = new URL(process.env.DATABASE_URL ?? "");
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";
  adminSql = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
});

// Dropping a database forces a checkpoint, which runs long when other suites share the server.
afterAll(async () => {
  for (const database of scratchDatabases) {
    await adminSql.unsafe(`drop database if exists "${database}" with (force)`);
  }
  await adminSql.end({ timeout: 5 });
}, 120_000);

/** A fresh, empty database for one test — migrations pending, nothing applied yet. */
async function createScratchDatabase(label: string): Promise<string> {
  const database = `migrate_lock_${label}_${Date.now()}`;
  await adminSql.unsafe(`create database "${database}"`);
  scratchDatabases.push(database);

  const base = new URL(process.env.DATABASE_URL ?? "");
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Runs the migrator as `scripts/start.sh` does: one node process, not pnpm and tsx's CLI wrapping it. */
function spawnMigrator(databaseUrl: string): { exited: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  let stdout = "";
  let stderr = "";
  const child = execFile(
    process.execPath,
    ["--import", "tsx", "scripts/migrate.ts"],
    { cwd: path.resolve(import.meta.dirname, "../.."), env: { ...process.env, DATABASE_URL: databaseUrl } },
    (error, out, err) => {
      stdout = out;
      stderr = err;
    },
  );
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { exited };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("migrator advisory lock", () => {
  it("blocks a concurrent run until the lock holder releases it", async () => {
    const databaseUrl = await createScratchDatabase("blocks");

    // Simulates a first container already migrating: hold the same lock the script takes.
    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    await holder`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;

    const migrator = spawnMigrator(databaseUrl);
    let settled = false;
    void migrator.exited.then(() => {
      settled = true;
    });

    for (;;) {
      const waiting = await holder`select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`;
      if (waiting.length > 0 || settled) break;
      await sleep(10);
    }
    expect(settled).toBe(false);

    await holder`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    await holder.end({ timeout: 5 });

    const result = await migrator.exited;
    expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);

    const check = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const [{ count }] = await check<[{ count: string }]>`select count(*)::text as count from drizzle.__drizzle_migrations`;
    expect(Number(count)).toBeGreaterThan(0);
    await check.end({ timeout: 5 });
  });

  it("applies the schema exactly once when two runs start at the same time", async () => {
    const databaseUrl = await createScratchDatabase("concurrent");

    const first = spawnMigrator(databaseUrl);
    const second = spawnMigrator(databaseUrl);

    const [a, b] = await Promise.all([first.exited, second.exited]);

    expect(a.code, `stdout: ${a.stdout}\nstderr: ${a.stderr}`).toBe(0);
    expect(b.code, `stdout: ${b.stdout}\nstderr: ${b.stderr}`).toBe(0);

    const check = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const rows = await check`select hash from drizzle.__drizzle_migrations order by hash`;
    const hashes = rows.map((row) => row.hash as string);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(hashes.length).toBeGreaterThan(0);
    await check.end({ timeout: 5 });
  });

  it("fails fast instead of queueing behind a held table lock", async () => {
    const databaseUrl = await createScratchDatabase("timeout");
    const first = await spawnMigrator(databaseUrl).exited;
    expect(first.code, `stdout: ${first.stdout}\nstderr: ${first.stderr}`).toBe(0);

    // Re-queues the newest migration, then holds every table it could touch.
    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    await holder`delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`;
    const tables = await holder<{ name: string }[]>`select quote_ident(tablename) as name from pg_tables where schemaname = 'public'`;
    const started = Date.now();
    let result: { code: number | null; stdout: string; stderr: string } | undefined;
    await holder.begin(async (tx) => {
      await tx.unsafe(`lock table ${tables.map((t) => t.name).join(", ")} in access exclusive mode`);
      result = await spawnMigrator(databaseUrl).exited;
    });
    await holder.end({ timeout: 5 });

    expect(result!.code).not.toBe(0);
    expect(result!.stderr).toMatch(/lock timeout/);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});
