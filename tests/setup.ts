import { workerDatabaseUrl } from "./database-url";
import { testRedisKeyPrefix } from "./redis";
import { testStoragePrefix } from "./storage-prefix";

// Overwritten, not just read: a child process the suite spawns inherits it and has to land in the
// same per-worker database.
process.env.TEST_DATABASE_URL = workerDatabaseUrl();
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
// Isolates this run's message bodies from every other checkout and process sharing the bucket.
process.env.STORAGE_KEY_PREFIX = testStoragePrefix();
// Isolates this worker's Redis keys and channels from every other worker, checkout and `pnpm dev:all`.
process.env.REDIS_KEY_PREFIX = testRedisKeyPrefix();
// Integration tests exercise the queue directly, so the nudge channel stays off.
delete process.env.REDIS_URL;
// SES pacing and retry backoff run on the real clock. Pacing tests restore SES's own rate.
process.env.SES_API_RATE_PER_SECOND = "1000";
process.env.SES_API_RETRY_BASE_MS = "1";
// Live DNS checks answer "couldn't check" at once instead of reaching a public resolver.
process.env.DNS_RESOLVERS ??= "127.0.0.1:9";
applyClockSkew();

/**
 * Runs the suite with the node clock shifted off the database's, which is the condition that
 * used to make the integration tests fail on some machines and pass on others (#88). Nothing
 * the app writes is allowed to depend on it, so the suite must be green at any offset:
 *
 *     TEST_CLOCK_SKEW_MS=2000 pnpm exec vitest run
 *     TEST_CLOCK_SKEW_MS=-2000 pnpm exec vitest run
 */
function applyClockSkew(): void {
  const skew = Number(process.env.TEST_CLOCK_SKEW_MS ?? 0);
  if (!Number.isFinite(skew) || skew === 0) return;

  const RealDate = Date;
  const shifted = class extends RealDate {
    constructor(...args: unknown[]) {
      // Only the no-argument form means "now"; every other form is an explicit instant.
      if (args.length === 0) super(RealDate.now() + skew);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static now(): number {
      return RealDate.now() + skew;
    }
  };
  globalThis.Date = shifted as DateConstructor;
}
