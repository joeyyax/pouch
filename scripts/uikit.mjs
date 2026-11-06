/**
 * Runs `shadcn add` over every @uikit item this app has installed, passing the rest of the
 * arguments through. An item counts as installed when any of its files is here. @uikit/brand
 * is a starter this app owns, so it's never re-added.
 *
 * Usage: pnpm uikit --dry-run | --diff [path] | --overwrite
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

for (const file of [".env.local", ".env"]) if (existsSync(file)) process.loadEnvFile(file);

const base = process.env.UIKIT_REGISTRY_URL;
if (!base) {
  console.error("Set UIKIT_REGISTRY_URL (see .env.example).");
  process.exit(1);
}

const response = await fetch(`${base}/registry.json`);
if (!response.ok) {
  console.error(`${base}/registry.json answered ${response.status}.`);
  process.exit(1);
}
const { items } = await response.json();
const installed = items
  .filter((item) => item.name !== "brand" && item.files?.some((file) => existsSync(file.target)))
  .map((item) => `@uikit/${item.name}`);

const { status } = spawnSync("pnpm", ["shadcn", "add", ...installed, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(status ?? 1);
