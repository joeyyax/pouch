/** Shared pieces of the screenshot passes: reading .env, signing in, and capturing. */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const BASE = process.env.DESIGN_BASE ?? "http://localhost:3100";

export const WIDTHS = [
  [1440, 900],
  [390, 844],
];
export const THEMES = ["light", "dark"];

export async function readEnv() {
  return Object.fromEntries(
    (await readFile(join(REPO, ".env"), "utf8"))
      .split("\n")
      .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
  );
}

/** Ids of the rows `pnpm dev:data` created, so no screenshot hard-codes one. */
export async function readLandmarks() {
  return JSON.parse(await readFile(join(REPO, ".dev-data.json"), "utf8"));
}

/** Where a signed-in state is kept between runs, per app and account. */
function sessionFile(env) {
  const key = createHash("sha256").update(`${BASE} ${env.ADMIN_EMAIL}`).digest("hex").slice(0, 12);
  return join(tmpdir(), `pouch-shots-${key}.json`);
}

/** The saved state, when its session still answers. */
async function savedSession(browser, env) {
  let state;
  try {
    state = JSON.parse(await readFile(sessionFile(env), "utf8"));
  } catch {
    return null;
  }
  const context = await browser.newContext({ storageState: state });
  try {
    const response = await context.request.get(`${BASE}/api/auth/get-session`);
    const body = response.ok() ? await response.json() : null;
    return body?.session ? state : null;
  } catch {
    return null;
  } finally {
    await context.close();
  }
}

/**
 * The storage state of a signed-in admin. Reuses the last run's session while it's live, so
 * shot runs don't leave a session each. Signing in retries: the dashboard's form-driven
 * signIn.email races Turbopack's first compile.
 */
export async function signIn(browser, env, attempts = 4) {
  const saved = await savedSession(browser, env);
  if (saved) return saved;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${BASE}/login?method=password`, { waitUntil: "domcontentloaded" });
      await page.fill('input[name="email"]', env.ADMIN_EMAIL);
      await page.fill('input[name="password"]', env.ADMIN_PASSWORD);
      await Promise.all([
        page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30000 }),
        page.click('button[type="submit"]'),
      ]);
      await page.waitForLoadState("networkidle");
      const state = await context.storageState();
      await context.close();
      await writeFile(sessionFile(env), JSON.stringify(state), { mode: 0o600 });
      return state;
    } catch (err) {
      process.stderr.write(`sign-in attempt ${attempt} failed: ${err.message}\n`);
      await context.close();
    }
  }
  throw new Error("sign-in failed after retries");
}

/** Playwright-core's own bundled Chromium, if one has been downloaded to the default cache. */
async function findBundledChromium() {
  const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  let entries;
  try {
    entries = await readdir(cacheDir);
  } catch {
    return null;
  }
  const versions = entries.filter((name) => /^chromium-\d+$/.test(name)).sort().reverse();
  for (const version of versions) {
    const executablePath = join(cacheDir, version, "chrome-linux64", "chrome");
    try {
      await readFile(executablePath);
      return executablePath;
    } catch {
      // not this one
    }
  }
  return null;
}

/** Drives the machine's own Chrome via the `chrome` channel, falling back to a bundled Chromium build when there isn't one. */
export async function launchBrowser() {
  const channel = process.env.CHROME_CHANNEL ?? "chrome";
  try {
    return await chromium.launch({ channel, headless: true });
  } catch (err) {
    const executablePath = await findBundledChromium();
    if (!executablePath) throw err;
    process.stderr.write(`no system Chrome (channel "${channel}"); using bundled Chromium at ${executablePath}\n`);
    return chromium.launch({ executablePath, headless: true });
  }
}

export function contextOptions(storageState, width, height, theme) {
  return {
    storageState,
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: "reduce",
  };
}

/** The kit's theme boot reads localStorage before anything paints. */
export const themeScript = (theme) =>
  `try{localStorage.setItem("theme",${JSON.stringify(theme)})}catch(e){}`;

/**
 * Grows the viewport to the page and takes a viewport shot, rather than a fullPage one.
 * fullPage resizes the viewport mid-capture, and a srcDoc iframe — the message body, the
 * layout preview — keeps the narrow layout it had during that resize, so the picture shows
 * a frame the browser never actually rendered.
 */
export async function capture(page, file, width, height) {
  // The dev overlay's corner badge is Next's, not the design's.
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  // A panel autofocuses its first action, whose tooltip then hangs over the screenshot.
  // Document the resting state; the focus behavior is a finding in its own right.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  const full = await page.evaluate(() => document.documentElement.scrollHeight);
  const tall = Math.min(Math.max(full, height), 8000);
  if (tall !== height) {
    await page.setViewportSize({ width, height: tall });
    // Let the iframes re-lay out at the size they'll be photographed at.
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: file });
  if (tall !== height) await page.setViewportSize({ width, height });
}
