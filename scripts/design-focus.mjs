/**
 * Traces document.activeElement through the flows that open and close something, and through
 * route changes between top-level sections.
 *
 * Focus loss is invisible to a screenshot and to the test suite: the dialog looks right, the
 * page renders, and the keyboard is simply stranded on <body>. `pnpm dev:data` first, the app
 * on 3100, then `pnpm design:focus` — every line must name a control, never BODY, and a route
 * change must land specifically on the new page's h1.
 */
import { chromium } from "playwright";
import { BASE, readEnv, readLandmarks, signIn, contextOptions } from "./lib/shots.mjs";

const browser = await chromium.launch();
const env = await readEnv();
const landmarks = await readLandmarks();
const storageState = await signIn(browser, env);
const context = await browser.newContext(contextOptions(storageState, 1440, 900, "light"));
const page = await context.newPage();
const dialog = page.locator("[role=dialog]");
let stranded = 0;

async function activeElementInfo() {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { at: "BODY", tag: null };
    const name = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 36);
    return { at: `${el.tagName.toLowerCase()} “${name}”`, tag: el.tagName.toLowerCase() };
  });
}

async function note(step) {
  const { at, tag } = await activeElementInfo();
  if (tag === null) stranded += 1;
  process.stdout.write(`${step.padEnd(34)} ${at}\n`);
}

/** Like `note`, but a route change must land focus on the new page's `h1` specifically —
 * anywhere else (including a stray control) is as broken as BODY for a screen-reader user. */
async function noteRouteFocus(step) {
  const { at, tag } = await activeElementInfo();
  if (tag !== "h1") stranded += 1;
  process.stdout.write(`${step.padEnd(34)} ${at}\n`);
}

// The create flow replaces the list, so there is no control left to return to on the way in.
await page.goto(`${BASE}/keys`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Create key", exact: true }).first().click();
await page.waitForTimeout(500);
await note("create key opened");
await page.getByRole("button", { name: "Cancel" }).click();
await page.waitForTimeout(800);
await note("create cancelled");

await page.getByRole("button", { name: "Create key", exact: true }).first().click();
await page.waitForTimeout(500);
await page.fill('input[name="name"]', `flow-focus-${Date.now().toString(36)}`);
await page.getByRole("button", { name: "Create key" }).click();
await page.waitForTimeout(1500);
await note("secret shown");
await page.getByRole("button", { name: "Done" }).click();
await page.waitForTimeout(900);
await note("secret dismissed");

// Escape and Cancel both go back to the button that opened the dialog.
await page.goto(`${BASE}/keys/${landmarks.scopeStaging}`, { waitUntil: "networkidle" });
await page.locator("main").getByRole("button", { name: "Revoke key" }).click();
await page.waitForTimeout(700);
await page.keyboard.press("Escape");
await page.waitForTimeout(900);
await note("revoke escaped");
await page.locator("main").getByRole("button", { name: "Revoke key" }).click();
await page.waitForTimeout(700);
await dialog.getByRole("button", { name: "Cancel" }).click();
await page.waitForTimeout(900);
await note("revoke cancelled");

// Confirming removes the button that opened it, so the heading takes focus instead.
await page.locator("main").getByRole("button", { name: "Revoke key" }).click();
await page.waitForTimeout(700);
await dialog.getByRole("button", { name: "Revoke key" }).click();
await page.waitForTimeout(1800);
await note("revoke confirmed");

// The detail panel is a row away, and the row is a new node by the time it closes.
await page.goto(`${BASE}/messages`, { waitUntil: "networkidle" });
await page.getByRole("row").nth(2).click();
await page.waitForTimeout(1200);
await page.keyboard.press("Escape");
await page.waitForTimeout(1200);
await note("message panel escaped");

await page.goto(`${BASE}/suppressions`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /^Remove / }).first().click();
await page.waitForTimeout(700);
await page.keyboard.press("Escape");
await page.waitForTimeout(900);
await note("suppression remove escaped");

// Route changes between top-level sections move focus forward to the new page's h1 and announce
// it, without stealing focus on the very first load and without touching the message
// list<->detail transition below (that one keeps its own row-focused restoration).
await page.goto(`${BASE}/messages`, { waitUntil: "networkidle" });
{
  const { at } = await activeElementInfo();
  process.stdout.write(`${"first load (no forced focus expected)".padEnd(34)} ${at}\n`);
}

await page.getByRole("link", { name: "Domains" }).click();
await page.waitForTimeout(1200);
await noteRouteFocus("nav messages -> domains");
const domainsAnnouncement = await page.locator('[role="status"]').first().textContent();
process.stdout.write(`  announced: “${domainsAnnouncement}”\n`);

await page.getByRole("link", { name: "Keys" }).click();
await page.waitForTimeout(1200);
await noteRouteFocus("nav domains -> keys");
const keysAnnouncement = await page.locator('[role="status"]').first().textContent();
process.stdout.write(`  announced: “${keysAnnouncement}”\n`);

// Opening then closing a message counts as two route changes (/messages -> /messages/:id and
// back) but stays inside one section — the announcer must stay quiet and the row must keep
// the focus message-detail.tsx already gives it.
await page.goto(`${BASE}/messages`, { waitUntil: "networkidle" });
const beforeAnnouncement = await page.locator('[role="status"]').first().textContent();
await page.getByRole("row").nth(2).click();
await page.waitForTimeout(600);
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
await note("message panel escaped (in-section, row keeps focus)");
const afterAnnouncement = await page.locator('[role="status"]').first().textContent();
if (afterAnnouncement !== beforeAnnouncement) {
  process.stderr.write(
    `\nroute announcer fired inside one section: “${beforeAnnouncement}” -> “${afterAnnouncement}”\n`,
  );
  stranded += 1;
}

await browser.close();
if (stranded > 0) {
  process.stderr.write(`\n${stranded} step(s) left focus on <body>\n`);
  process.exit(1);
}
process.stdout.write("\nfocus returned at every step\n");
