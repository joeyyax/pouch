import { execFileSync } from "node:child_process";
import postgres from "postgres";
import type { TestProject } from "vitest/node";
import { acquireRunLock } from "./database-lock";
import { testDatabaseUrl, workerDatabaseUrl } from "./database-url";

/**
 * Creates this checkout's test database if it's missing, applies migrations, clones one copy per
 * worker, and holds an advisory lock on it for the run. A second run refuses to start rather than
 * share it. Hands the tests `REDIS_URL` before `setup.ts` removes it.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL isn't set. Copy .env.example to .env.");
  project.provide("redisUrl", redisUrl);

  const url = testDatabaseUrl();

  const parsed = new URL(url);
  const database = parsed.pathname.slice(1);
  parsed.pathname = "/postgres";
  const adminUrl = parsed.toString();

  const releaseLock = await acquireRunLock(adminUrl, database);

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const existing = await admin`select 1 from pg_database where datname = ${database}`;
    if (existing.length === 0) await admin.unsafe(`create database "${database}"`);

    execFileSync("pnpm", ["exec", "drizzle-kit", "migrate"], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    });

    for (let worker = 1; worker <= Math.max(1, project.config.maxWorkers); worker += 1) {
      const copy = new URL(workerDatabaseUrl(worker)).pathname.slice(1);
      await admin.unsafe(`drop database if exists "${copy}" with (force)`);
      await admin.unsafe(`create database "${copy}" template "${database}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  console.log(`test database: ${database}`);

  return releaseLock;
}
