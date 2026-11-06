/**
 * Publishes sdk/ to npm as @joeyyax/pouch. Refuses off main, on a dirty or stale tree, or on a
 * version npm already has; then runs the SDK tests, builds and publishes as the `npm login`
 * account. A passkey's approval opens in the browser, so no prompt is needed;
 * `--otp=<code>` passes an authenticator code through instead. NPM_TOKEN, when set, is used instead. `--dry-run` stops before the upload.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SDK = join(ROOT, "sdk");
const dryRun = process.argv.includes("--dry-run");
const otp = process.argv.find((arg) => arg.startsWith("--otp="));

function run(command: string, args: string[], cwd = ROOT): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function refuse(reason: string): never {
  console.error(`release:sdk: ${reason}`);
  process.exit(1);
}

const { name, version } = JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as { name: string; version: string };

if (run("git", ["branch", "--show-current"]) !== "main") refuse("not on main.");
if (run("git", ["status", "--porcelain"]) !== "") refuse("the working tree isn't clean.");
run("git", ["fetch", "--quiet", "origin", "main"]);
if (run("git", ["rev-parse", "HEAD"]) !== run("git", ["rev-parse", "origin/main"])) refuse("main isn't at origin/main.");

let published = "";
try {
  published = run("npm", ["view", `${name}@${version}`, "version"]);
} catch {
  // 404: this version isn't on npm.
}
if (published === version) refuse(`${name}@${version} is already on npm. Bump sdk/package.json.`);

const token = process.env.NPM_TOKEN;
if (!token && !dryRun) {
  try {
    console.log(`release:sdk: publishing as ${run("npm", ["whoami"])}.`);
  } catch {
    refuse("not signed in to npm. Run `npm login` first.");
  }
}

execFileSync("pnpm", ["vitest", "run", "tests/unit/sdk.test.ts", "tests/unit/sdk-coverage.test.ts"], { cwd: ROOT, stdio: "inherit" });
execFileSync("pnpm", ["tsx", "scripts/build-sdk.ts"], { cwd: ROOT, stdio: "inherit" });

const publish = ["publish", ...(dryRun ? ["--dry-run"] : []), ...(otp ? [otp] : [])];
if (token) {
  const config = mkdtempSync(join(tmpdir(), "release-sdk-"));
  const npmrc = join(config, ".npmrc");
  writeFileSync(npmrc, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
  try {
    execFileSync("npm", [...publish, "--userconfig", npmrc], { cwd: SDK, stdio: "inherit" });
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
} else {
  await publishWithApproval(publish);
}
console.log(dryRun ? `release:sdk: ${name}@${version} would publish.` : `release:sdk: published ${name}@${version}.`);

/**
 * Runs npm publish under a pseudo-terminal, since npm masks the approval link and won't wait for it
 * without one. Opens the link npm prints; npm waits for the passkey and finishes on its own.
 */
async function publishWithApproval(args: string[]): Promise<void> {
  const child = spawn("script", ["-q", "/dev/null", "npm", ...args], { cwd: SDK, stdio: ["ignore", "pipe", "inherit"] });
  let opened = false;
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    process.stdout.write(text);
    const link = /https:\/\/www\.npmjs\.com\/auth\/cli\/[\w-]+/.exec(text)?.[0];
    if (link && !opened) {
      opened = true;
      console.log(`\nrelease:sdk: approve the publish in the browser: ${link}`);
      spawnSync("open", [link], { stdio: "ignore" });
    }
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  if (code !== 0) refuse("npm publish failed.");
}
