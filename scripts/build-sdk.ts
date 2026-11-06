/** Builds sdk/pouch.ts into sdk/dist: ESM, CJS and declarations for both. */
import { execFileSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build, type BuildOptions } from "esbuild";

const SDK = join(import.meta.dirname, "..", "sdk");
const DIST = join(SDK, "dist");

rmSync(DIST, { recursive: true, force: true });
const common: BuildOptions = { entryPoints: [join(SDK, "pouch.ts")], bundle: true, platform: "neutral", target: "es2022" };
await build({ ...common, format: "esm", outfile: join(DIST, "pouch.js") });
await build({ ...common, format: "cjs", outfile: join(DIST, "pouch.cjs") });
execFileSync(
  "tsc",
  ["--ignoreConfig", join(SDK, "pouch.ts"), "--declaration", "--emitDeclarationOnly", "--outDir", DIST, "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"],
  { stdio: "inherit" },
);
copyFileSync(join(DIST, "pouch.d.ts"), join(DIST, "pouch.d.cts"));
console.log(`built ${DIST}`);
