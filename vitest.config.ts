import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    hookTimeout: 30_000,
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          setupFiles: ["tests/setup.ts"],
          include: ["tests/unit/**/*.test.ts"],
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          globalSetup: ["tests/global-setup.ts"],
          setupFiles: ["tests/setup.ts", "tests/integration/setup.ts"],
          include: ["tests/integration/**/*.test.ts"],
          // Each worker gets its own clone of the test database, keyed by VITEST_POOL_ID. Runs
          // first: Vitest can hand one pool id to two files in a group that follows another.
          maxWorkers: 4,
          sequence: { groupOrder: 0 },
        },
      },
    ],
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, ".") },
  },
});
