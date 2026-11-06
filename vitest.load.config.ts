import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts", "tests/integration/setup.ts"],
    include: ["tests/load/**/*.test.ts"],
    hookTimeout: 30_000,
    testTimeout: 600_000,
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, ".") },
  },
});
