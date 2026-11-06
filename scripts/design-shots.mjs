/**
 * Screenshots every dashboard screen and state, at two widths in both themes.
 *
 * The kit ships playwright-core, which downloads no browsers — so this drives
 * the Chrome already on the machine, same as the kit's own capture scripts.
 * Signs in once with the admin credentials from .env and reuses the session,
 * because the dashboard is behind Better Auth and this pass didn't add a
 * bypass to get around that.
 *
 * Run: pnpm design:shots [filter]
 */
import { mkdir, rm } from "node:fs/promises";
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
const filter = process.argv[2];

const landmarks = await readLandmarks();
const env = await readEnv();

/** Opens the first endpoint's delivery log, then its newest delivery's dialog. */
async function openDelivery(page) {
  await page.locator("summary", { hasText: "Delivery log" }).first().click();
  await page.locator("details[open] li button").first().click();
  await page.getByRole("dialog").getByText("#1").first().waitFor();
}

/** Opens the newest activity entry's panel. */
async function openActivity(page) {
  await page.locator("[data-row-key]").first().click();
  await page.waitForURL(/\/activity\/act_/);
  await page.getByRole("dialog").waitFor();
}

/** Opens the healthy loops behind the Status summary line. */
async function openLoops(page) {
  await page.getByRole("button", { name: /loops? alive/ }).click();
}

/** Opens the address's extend dialog from its header. */
async function openExtend(page) {
  await page.getByRole("button", { name: /^(Extend|Reopen)$/ }).first().click();
  await page.getByRole("dialog").waitFor();
}

/** Opens the address's revoke confirmation from its header. */
async function openRevoke(page) {
  await page.getByRole("button", { name: "Revoke", exact: true }).first().click();
  await page.getByRole("alertdialog").or(page.getByRole("dialog")).first().waitFor();
}

/** Opens the list's create form. */
async function openCreateAddress(page) {
  await page.getByRole("button", { name: "New address" }).click();
  await page.getByRole("dialog").waitFor();
}

/** Picks the production key, which reaches the inbound domain. */
async function fillCreateAddress(page) {
  await openCreateAddress(page);
  await page.getByLabel(/^Key/).selectOption({ label: "scope-production" });
  await page.getByLabel("Local part").fill("signup-test");
  await page.getByLabel("Label").fill("Signup flow e2e");
}

/** Submits a reserved local part, which the API's own schema refuses. */
async function refuseCreateAddress(page) {
  await fillCreateAddress(page);
  await page.getByLabel("Local part").fill("postmaster");
  await page.getByRole("button", { name: "Create address" }).click();
  await page.getByText(/reserved for the domain/).waitFor();
}

/** Picks a key whose domains have no inbound. */
async function unreachableCreateAddress(page) {
  await openCreateAddress(page);
  await page.getByLabel(/^Key/).selectOption({ label: "fieldnotes-app" });
}

/** Opens the explanation of the organization's address limits. */
async function openLimits(page) {
  await page.getByText(/messages a day each/).first().hover();
  await page.getByText(/set by an admin/).first().waitFor();
}

/**
 * screen, state, path and an optional step after load. The filename is `<screen>-<state>-<width>-<theme>.png`.
 * Ids come from the development database, so run `pnpm dev:data` first and pass the ids
 * this script resolves at start rather than hard-coding them.
 */
const TARGETS = [
  ["overview", "default", "/"],

  ["messages", "list", "/messages"],
  ["messages", "needs-attention", "/messages?preset=attention"],
  ["messages", "filtered-status", "/messages?status=delivered,sent"],
  ["messages", "scoped", "/messages?domain=scope.example"],
  ["messages", "filtered-empty", "/messages?domain=cedarvine.com"],
  ["messages", "searched", "/messages?q=digest"],
  ["messages", "detail-delivered", "/messages/:delivered"],
  ["messages", "detail-deferred", "/messages/:deferred"],
  ["messages", "detail-bounced", "/messages/:bounced"],
  ["messages", "detail-failed", "/messages/:failed"],
  ["messages", "detail-queued-past-window", "/messages/:stuck"],
  ["messages", "detail-body-expired", "/messages/:expired"],
  ["messages", "detail-headers", "/messages/:delivered#headers"],

  ["domains", "list", "/domains"],
  ["domains", "add", "/domains?state=add"],
  ["domains", "detail-verified", "/domains/:scope"],
  ["domains", "detail-reputation", "/domains/:scope/reputation"],
  ["domains", "detail-pending", "/domains/:moc"],
  ["domains", "detail-failed", "/domains/:cedarvine"],
  ["domains", "detail-delete", "/domains/:moc?state=delete"],

  ["keys", "list", "/keys"],
  ["keys", "create", "/keys?state=create"],
  ["keys", "detail", "/keys/:scopeProd"],
  ["keys", "revoke", "/keys/:scopeProd?state=revoke"],
  ["keys", "detail-delivery", "/keys/:scopeProd", openDelivery],

  ["addresses", "list", "/addresses"],
  ["addresses", "filtered", "/addresses?status=expired"],
  ["addresses", "limits", "/addresses", openLimits],
  ["addresses", "create", "/addresses", fillCreateAddress],
  ["addresses", "create-refused", "/addresses", refuseCreateAddress],
  ["addresses", "create-no-inbound-for-key", "/addresses", unreachableCreateAddress],
  ["addresses", "detail", "/addresses/:addressForward"],
  ["addresses", "detail-near-cap", "/addresses/:addressNearCap"],
  ["addresses", "detail-expired", "/addresses/:addressExpired"],
  ["addresses", "detail-revoked", "/addresses/:addressRevoked"],
  ["addresses", "detail-long", "/addresses/:addressLong"],
  ["addresses", "extend", "/addresses/:addressActive", openExtend],
  ["addresses", "reopen", "/addresses/:addressExpired", openExtend],
  ["addresses", "revoke", "/addresses/:addressActive", openRevoke],

  ["lists", "list", "/lists"],
  ["lists", "detail", "/lists/:list"],

  ["activity", "list", "/activity"],
  ["activity", "filtered", "/activity?family=key,webhook"],
  ["activity", "detail", "/activity", openActivity],

  ["suppressions", "list", "/suppressions"],
  ["suppressions", "add", "/suppressions?state=add"],
  ["suppressions", "filtered", "/suppressions?address=cedarvine"],
  ["suppressions", "detail", "/suppressions/:suppression"],

  ["settings", "default", "/settings"],

  ["status", "default", "/admin/settings/system"],
  ["status", "loops-open", "/admin/settings/system", openLoops],
]
  .map(([screen, state, path, step]) => [screen, state, path.replace(/:(\w+)/g, (_match, name) => landmarks[name] ?? _match), step])
  .filter(([screen, state]) => !filter || `${screen}-${state}`.includes(filter));

for (const [screen, state, path] of TARGETS) {
  if (path.includes(":")) throw new Error(`${screen}-${state}: no id for ${path}. Run \`pnpm dev:data\` first.`);
}

if (!filter) await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const browser = await launchBrowser();

const storageState = await signIn(browser, env);

let taken = 0;
for (const theme of THEMES) {
  for (const [width, height] of WIDTHS) {
    const context = await browser.newContext(contextOptions(storageState, width, height, theme));
    await context.addInitScript(themeScript(theme));

    const page = await context.newPage();
    for (const [screen, state, path, step] of TARGETS) {
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      if (step) await step(page);
      await capture(page, join(OUT, `${screen}-${state}-${width}-${theme}.png`), width, height);
      taken += 1;
      process.stdout.write(`${screen}-${state}-${width}-${theme}\n`);
    }
    await context.close();
  }
}

await browser.close();
console.log(`\n${taken} screenshots in ${OUT}`);