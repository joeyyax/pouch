import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminActor } from "@/lib/activity/record";
import { assertFeatureEnabled } from "@/lib/features";
import { forgetSettingsFile, loadSettingsFile } from "@/lib/settings/file";
import { readSetting, readSettings, setSetting } from "@/lib/settings/values";
import { SettingsSections } from "@/app/(app)/admin/settings/general/settings-sections";
import { resetDatabase, seedUser } from "./fixtures";

const sessionState = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/auth/session", async () => (await import("./fixtures")).adminSessionModule(sessionState));

const { GET } = await import("@/app/api/dashboard/settings/export/route");

const ADMIN = adminActor("usr_admin", "Admin");

let dir: string;

/** Points this process at a settings file holding `text`. */
function useFile(text: string, name = "pouch.yml"): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  vi.stubEnv("CONFIG_FILE", path);
  forgetSettingsFile();
  return path;
}

beforeEach(async () => {
  await resetDatabase();
  dir = mkdtempSync(join(tmpdir(), "pouch-yml-"));
  sessionState.userId = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
  forgetSettingsFile();
  rmSync(dir, { recursive: true, force: true });
});

describe("resolution", () => {
  it("[control] takes the environment over the stored value without a file", async () => {
    vi.stubEnv("STALL_BOUNCE_PERCENT", "2");
    await setSetting("stall_complaint_percent", 0.03, ADMIN);
    expect(await readSetting("stall_bounce_percent")).toBe(2);
    expect(await readSetting("stall_complaint_percent")).toBe(0.03);
  });

  it("takes the environment over the file, and the file over the stored value", async () => {
    await setSetting("stall_complaint_percent", 0.03, ADMIN);
    vi.stubEnv("STALL_BOUNCE_PERCENT", "2");
    useFile("stall_bounce_percent: 1\nstall_complaint_percent: 0.02\n");
    expect(await readSetting("stall_bounce_percent")).toBe(2);
    expect(await readSetting("stall_complaint_percent")).toBe(0.02);
  });

  it("locks a value both set under the environment variable, which won", async () => {
    vi.stubEnv("STALL_BOUNCE_COUNT", "2");
    useFile("stall_bounce_count: 1\n");
    await expect(setSetting("stall_bounce_count", 1, ADMIN)).rejects.toMatchObject({
      message: "STALL_BOUNCE_COUNT sets Pause bounce count, so it changes there.",
    });
  });

  it("refuses a dashboard change to a value the file sets, naming the file", async () => {
    useFile("stall_bounce_count: 2\n", "mail.yml");
    await expect(setSetting("stall_bounce_count", 1, ADMIN)).rejects.toMatchObject({
      code: "validation_failed",
      message: "mail.yml sets Pause bounce count, so it changes there.",
    });
  });
});

describe("feature_disabled", () => {
  it.each([
    ["the environment", () => vi.stubEnv("FEATURE_MCP", "off"), 'Feature "mcp" is turned off by FEATURE_MCP.'],
    ["the file", () => useFile("mcp: false\n", "mail.yml"), 'Feature "mcp" is turned off in mail.yml.'],
    ["the dashboard", () => setSetting("mcp", false, ADMIN), 'Feature "mcp" is turned off in Admin settings → Access.'],
  ])("names %s as where it was turned off", async (_label, turnOff, message) => {
    await turnOff();
    await expect(assertFeatureEnabled("mcp")).rejects.toMatchObject({ code: "feature_disabled", message });
  });

  it("names what a feature needs, and where that was turned off", async () => {
    useFile("bulk: false\n");
    await expect(assertFeatureEnabled("lists")).rejects.toMatchObject({
      message: 'Feature "lists" is turned off because "bulk" is, in pouch.yml.',
    });
  });

  it("[control] passes while the feature is on", async () => {
    await expect(assertFeatureEnabled("lists")).resolves.toBeUndefined();
  });
});

describe("Admin settings tabs", () => {
  it("locks a value the file sets, with the file's name", async () => {
    useFile("body_retention_max_days: 90\n", "mail.yml");
    const html = renderToStaticMarkup(createElement(SettingsSections, { settings: await readSettings(), configFile: "mail.yml" }));
    expect(html).toContain('Set in <code class="font-mono text-xs">mail.yml</code>. Change it there and restart.');
    expect(html).toMatch(/id="setting-body_retention_max_days"[^>]*disabled=""/);
  });

  it("[control] leaves a value the file doesn't set editable", async () => {
    const html = renderToStaticMarkup(createElement(SettingsSections, { settings: await readSettings(), configFile: "pouch.yml" }));
    expect(html).not.toContain("Set in <code");
    expect(html).not.toMatch(/id="setting-body_retention_max_days"[^>]*disabled=""/);
  });
});

describe("GET /api/dashboard/settings/export", () => {
  const request = () => new Request("http://localhost:3100/api/dashboard/settings/export");

  it("answers 404 to someone who isn't an admin", async () => {
    expect((await GET(request())).status).toBe(404);
    sessionState.userId = (await seedUser({ admin: false })).userId;
    expect((await GET(request())).status).toBe(404);
  });

  it("downloads the values off their defaults, and the loader reads them back", async () => {
    sessionState.userId = (await seedUser({ admin: true })).userId;
    await setSetting("bulk", false, ADMIN);
    await setSetting("stall_bounce_percent", 1.4, ADMIN);
    vi.stubEnv("BODY_RETENTION_MAX_DAYS", "120");

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="pouch.yml"');
    const path = join(dir, "exported.yml");
    writeFileSync(path, await response.text());

    const { values } = loadSettingsFile({ CONFIG_FILE: path });
    expect(values).toEqual({ bulk: false, stall_bounce_percent: 1.4, body_retention_max_days: 120 });
  });
});
