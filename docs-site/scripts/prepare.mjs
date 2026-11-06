// Copies the guides from docs/ and writes openapi.json from lib/api-docs/spec.ts. Both outputs are gitignored.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = dirname(site);

const GUIDES = {
  "self-hosting.md": "docs/self-hosting.md",
  "leaving.md": "docs/leaving.md",
  "mcp.md": "docs/mcp.md",
  "conventions.md": "docs/api/conventions.md",
};

// Each guide opens with its own H1; the page renders the title from frontmatter.
mkdirSync(join(site, "guides"), { recursive: true });
for (const [name, from] of Object.entries(GUIDES)) {
  const text = readFileSync(join(repo, from), "utf8").replace(/^# .*\n+/, "");
  writeFileSync(join(site, "guides", name), text);
}

const tsx = join(repo, "node_modules/.bin/tsx");
if (existsSync(tsx)) {
  execFileSync(tsx, ["scripts/gen-openapi.ts", join(site, "openapi.json")], { cwd: repo, stdio: "inherit" });
} else if (!existsSync(join(site, "openapi.json"))) {
  throw new Error("No openapi.json and no root install to generate it. Run pnpm install at the repo root.");
}
