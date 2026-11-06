import { defineConfig } from "vitest/config";
import path from "node:path";

// The build gate's config: unit tests only, no database or Redis.
export default defineConfig({
  test: {
    setupFiles: ["tests/setup.ts"],
    include: ["tests/unit/**/*.test.ts"],
    testTimeout: 30_000,
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, ".") },
  },
});
