import { createHash } from "node:crypto";
import { config } from "dotenv";

config({ path: "./.env", quiet: true });

/**
 * The test database for this checkout, `TEST_DATABASE_URL` with a per-checkout suffix.
 *
 * `fixtures.ts` truncates every table between tests, so two checkouts pointed at one database
 * delete each other's rows mid-run — which surfaces as foreign-key violations far from the cause.
 */
export function testDatabaseUrl(): string {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_DATABASE_URL isn't set. Copy .env.example to .env.");

  const url = new URL(base);
  url.pathname = `/${url.pathname.slice(1)}_${checkoutTag()}`;
  return url.toString();
}

/** One worker's copy of the test database, cloned from `testDatabaseUrl()` by `global-setup.ts`. */
export function workerDatabaseUrl(worker = workerId()): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = `${url.pathname}_w${worker}`;
  return url.toString();
}

/** Vitest's pool slot, 1 to `maxWorkers`. */
export function workerId(): number {
  return Number(process.env.VITEST_POOL_ID ?? 1);
}

/** Hashed from this file's own path, so it's the same whichever directory the run started in. */
export function checkoutTag(): string {
  return createHash("sha256").update(import.meta.dirname).digest("hex").slice(0, 8);
}
