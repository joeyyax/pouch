/**
 * Screenshots the states you can only reach by doing something: creating a key and seeing
 * its secret once, editing a domain's layout, suppressing an address. Each one runs the real
 * mutation against the real API, so a green run is also proof the flow works.
 *
 * Leaves rows behind on purpose — the names are prefixed `flow-` so `pnpm dev:data` clears
 * them on its next run. A run that failed part way through leaves a live key holding its
 * name, and a live name can't be reused: run `pnpm dev:data` before retrying.
 *
 * Run: pnpm design:flows
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  capture,
  contextOptions,
  launchBrowser,
  readEnv,
  readLandmarks,
  signIn,
  themeScript,
  BASE,
  THEMES,
  WIDTHS,
} from "./lib/shots.mjs";

const OUT = process.env.DESIGN_OUT ?? join(homedir(), "working/pouch/design");
await mkdir(OUT, { recursive: true });

const landmarks = await readLandmarks();
const env = await readEnv();

const browser = await launchBrowser();
const storageState = await signIn(browser, env);

let taken = 0;

for (const theme of THEMES) {
  for (const [width, height] of WIDTHS) {
    const context = await browser.newContext(contextOptions(storageState, width, height, theme));
    await context.addInitScript(themeScript(theme));
    const page = await context.newPage();
    const suffix = `${width}-${theme}`;
    const shot = async (name) => {
      await capture(page, join(OUT, `${name}-${suffix}.png`), width, height);
      taken += 1;
      process.stdout.write(`${name}-${suffix}\n`);
    };

    // A key, minted and shown once. The name is reused every run, so the pass revokes it
    // again below — a live key can't share a name, and that guard is the point.
    const keyName = `flow-${width}-${theme}`;
    await page.goto(`${BASE}/keys?state=create`, { waitUntil: "networkidle" });
    await page.fill("#key-name", keyName);
    await page.selectOption("#key-domains", [landmarks.scope]);
    await page.fill("#key-rate", "200");
    await page.click('button[type="submit"]');
    await page.waitForSelector("text=Key created", { timeout: 15000 });
    await shot("keys-created");

    // Revoking it: the confirm dialog, then the revoked detail.
    await page.click('button:has-text("Done")');
    await page.waitForURL(/\/keys$/, { timeout: 10000 });
    // Follow the row's own href rather than clicking it: a toast sits over the table.
    const href = await page.getAttribute(`a:has-text("${keyName}")`, "href");
    await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
    await page.waitForSelector('button:has-text("Revoke key")', { timeout: 10000 });
    await page.click('button:has-text("Revoke key")');
    await page.waitForSelector("text=Anything using it stops sending immediately.", { timeout: 10000 });
    await shot("keys-revoke-confirm");
    // The page and the dialog both offer "Revoke key"; the page's one is behind the overlay.
    await page
      .locator('[role="dialog"],[role="alertdialog"]')
      .getByRole("button", { name: "Revoke key" })
      .click();
    await page.waitForSelector("text=Key revoked", { timeout: 15000 });
    await shot("keys-revoked");

    // The layout editor and its live preview.
    await page.goto(`${BASE}/domains/${landmarks.scope}`, { waitUntil: "networkidle" });
    await page.click('button:has-text("Edit")');
    await page.waitForSelector("#layout-footer", { timeout: 10000 });
    await shot("domains-layout-edit");

    // An address suppressed by hand, confirmed by its toast.
    await page.goto(`${BASE}/suppressions?state=add`, { waitUntil: "networkidle" });
    await page.fill("#suppression-address", `flow-${width}-${theme}@example.com`);
    await page.fill("#suppression-note", "Added while verifying the flow.");
    await page.click('button:has-text("Suppress address")');
    await page.waitForSelector("text=now fail", { timeout: 15000 });
    await shot("suppressions-added");

    await context.close();
  }
}

await browser.close();
console.log(`\n${taken} screenshots in ${OUT}`);
