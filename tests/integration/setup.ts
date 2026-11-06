import { afterAll } from "vitest";

// Every file opens its own connections. Closing them here covers every file, so no test has to remember.
afterAll(async () => {
  const [{ closeDb }, { closeRedis }, { closeStorage }] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/redis"),
    import("@/lib/storage"),
  ]);
  await Promise.all([closeDb(), closeRedis(), closeStorage()]);
});
