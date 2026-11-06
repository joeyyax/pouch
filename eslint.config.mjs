import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import noUndefinedTypeClasses from "./scripts/eslint-rules/no-undefined-type-classes.mjs";
import noSchemaMutationInTests from "./scripts/eslint-rules/no-schema-mutation-in-tests.mjs";
import noRelativeTimeInClient from "./scripts/eslint-rules/no-relative-time-in-client.mjs";
import noDbInApp from "./scripts/eslint-rules/no-db-in-app.mjs";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: {
      local: {
        rules: {
          "no-undefined-type-classes": noUndefinedTypeClasses,
          "no-schema-mutation-in-tests": noSchemaMutationInTests,
          "no-relative-time-in-client": noRelativeTimeInClient,
          "no-db-in-app": noDbInApp,
        },
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
      "@typescript-eslint/no-explicit-any": "error",
      "local/no-undefined-type-classes": "error",
    },
  },
  // A relative label rendered on both sides disagrees by a few seconds. Time is what handles it,
  // so it's the one client component allowed to build one.
  {
    files: ["app/**/*.tsx"],
    ignores: ["app/(app)/_ui/time.tsx"],
    rules: {
      "local/no-relative-time-in-client": "error",
    },
  },
  // A test that changes the schema has to hand it back, whatever happens to the test.
  {
    files: ["tests/**"],
    ignores: ["tests/integration/migration-replay.ts"],
    rules: {
      "local/no-schema-mutation-in-tests": "error",
    },
  },
  // Actions, pages and components read and write through lib/. Route handlers are surfaces of their own.
  {
    files: ["app/**/*.ts", "app/**/*.tsx"],
    ignores: ["app/**/route.ts"],
    rules: {
      "local/no-db-in-app": "error",
    },
  },
  // One locale for numbers and dates, so a server render and its client can't print different digits.
  {
    files: ["app/**", "components/**", "lib/**", "worker/**"],
    rules: {
      "no-restricted-properties": ["error",
        ...["toLocaleString", "toLocaleDateString", "toLocaleTimeString"].map((property) => ({
          property,
          message: "Use formatNumber (lib/format/number.ts) or the zone-aware helpers in lib/format/time.ts.",
        })),
      ],
    },
  },
  // Admins own every provider. Organization-facing code never reaches the write path.
  {
    files: ["app/api/v1/**", "app/(app)/**"],
    ignores: ["app/api/v1/admin/**", "app/(app)/admin/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ regex: "(^|/)lib/providers/admin$", message: "Admin provider writes belong under admin/** only." }],
      }],
    },
  },
  // Local git worktrees under .claude, each with its own .next build output. Without this, lint walks
  // every one of them and the suite fails on generated code.
  // The Cloudflare Queue consumer Worker is a separate deployable with its own tsconfig and
  // Workers-runtime globals; it isn't part of this Next.js program.
  globalIgnores([".next/**", "out/**", "build/**", "drizzle/**", "next-env.d.ts", ".claude/**", "cloudflare/**", "docs-site/**"]),
]);
