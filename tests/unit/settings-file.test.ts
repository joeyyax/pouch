import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkBootConfig } from "@/lib/config";
import { exportSettingsFile, loadSettingsFile } from "@/lib/settings/file";
import { ALL_SETTINGS, resolveSettings, settingDef } from "@/lib/settings/registry";

/** The smallest environment that boots on a laptop, so only the file can fail. */
const LOCAL = {
  DATABASE_URL: "postgresql://mail:mail@localhost:5440/mail",
  ENCRYPTION_KEY: "cG91Y2gtZGV2ZWxvcG1lbnQtb25seS1rZXktMzJieXQ=",
  STORAGE_ENDPOINT: "http://localhost:9010",
  STORAGE_BUCKET: "mail-bodies",
  STORAGE_ACCESS_KEY_ID: "minioadmin",
  STORAGE_SECRET_ACCESS_KEY: "minioadmin",
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pouch-yml-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function write(text: string, name = "pouch.yml"): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

/** Runs the boot check against a file; answers what it printed when it exited, or null when it didn't. */
function boot(path: string, role: "app" | "worker" | "smtp" = "app"): string | null {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  checkBootConfig(role, { ...LOCAL, CONFIG_FILE: path });
  if (exit.mock.calls.length === 0) return null;
  expect(exit).toHaveBeenCalledWith(1);
  return error.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("precedence", () => {
  it("takes the environment over the file", () => {
    const states = resolveSettings({ STALL_BOUNCE_PERCENT: "2.0", FEATURE_MCP: "off" }, {}, { stall_bounce_percent: 1, mcp: true });
    expect(states.stall_bounce_percent).toMatchObject({ value: 2, source: "env" });
    expect(states.mcp).toMatchObject({ value: false, source: "env" });
  });

  it("takes the file over the stored value and the default", () => {
    const states = resolveSettings({}, { stall_bounce_percent: 1.5, mcp: true }, { stall_bounce_percent: 1, mcp: false });
    expect(states.stall_bounce_percent).toMatchObject({ value: 1, source: "file" });
    expect(states.mcp).toMatchObject({ value: false, source: "file" });
    expect(states.stall_bounce_count).toMatchObject({ value: 3, source: "default" });
  });

  it("turns a dependent feature off when the file turns off what it needs", () => {
    const states = resolveSettings({}, {}, { bulk: false });
    expect(states.lists).toMatchObject({ value: true, available: false });
  });
});

describe("boot", () => {
  it("starts with a valid file", () => {
    expect(boot(write("bulk: false\nstall_bounce_percent: 1.5\nbody_retention_max_days: 90\n"))).toBeNull();
  });

  it("starts with no file at the default path", () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    expect(loadSettingsFile({ ...LOCAL }).values).toEqual({});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    checkBootConfig("app", { ...LOCAL });
    expect(exit).not.toHaveBeenCalled();
  });

  it("fails on an unknown key, naming it", () => {
    const printed = boot(write("bulk: false\nbulkk: true\n"));
    expect(printed).toContain("bulkk isn't a setting.");
    expect(printed).not.toContain("bulk:");
  });

  it("fails on an out-of-bounds value, naming the key and the reason", () => {
    const printed = boot(write("body_retention_max_days: 3\n"), "worker");
    expect(printed).toContain("body_retention_max_days is a whole number from 7 to 730. It's 3.");
  });

  it("fails on a reputation line looser than its default", () => {
    expect(boot(write("stall_bounce_percent: 5\n"))).toContain("stall_bounce_percent can't be looser than its default, 2.5%.");
  });

  it("names the variable's key when the file uses an environment name", () => {
    expect(boot(write("FEATURE_BULK: false\n"))).toContain("FEATURE_BULK is the environment variable; the file names it bulk.");
  });

  it("refuses a secret, which stays in the environment", () => {
    expect(boot(write("ENCRYPTION_KEY: abc\n"))).toContain("ENCRYPTION_KEY isn't a setting. Environment variables, secrets included, stay in the environment.");
  });

  it("lists every problem at once", () => {
    const printed = boot(write("nope: 1\nmcp: maybe\nbulk:\n"));
    expect(printed).toContain("nope isn't a setting.");
    expect(printed).toContain(`mcp is on or off. It's "maybe".`);
    expect(printed).toContain("bulk has no value.");
  });

  it("fails on malformed YAML", () => {
    expect(boot(write("bulk: [false\n"))).toContain("isn't valid YAML");
  });

  it("fails when CONFIG_FILE names a file that isn't there", () => {
    expect(boot(join(dir, "missing.yml"))).toContain("doesn't exist");
  });

  it("warns about an environment variable that overrides the file, and starts", () => {
    const path = write("bulk: false\nmcp: true\n");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkBootConfig("app", { ...LOCAL, CONFIG_FILE: path, FEATURE_BULK: "on", FEATURE_LISTS: "off" });
    expect(exit).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual(["[config] FEATURE_BULK overrides pouch.yml's bulk."]);
  });

  it("fails the SMTP ingress the same way", () => {
    expect(boot(write("bulkk: true\n"), "smtp")).toContain("bulkk isn't a setting.");
  });
});

describe("boot, on the environment", () => {
  /** Boots with no file and `extra` in the environment; answers what it printed when it exited, or null. */
  function bootEnv(extra: Record<string, string>, role: "app" | "worker" | "smtp" = "app"): string | null {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    checkBootConfig(role, { ...LOCAL, ...extra });
    return exit.mock.calls.length === 0 ? null : error.mock.calls.map((call) => String(call[0])).join("\n");
  }

  it("[control] starts with registry variables that parse", () => {
    expect(bootEnv({ STALL_BOUNCE_PERCENT: "1.5", FEATURE_MCP: "off", ORGANIZATION_CREATION: "closed", BODY_RETENTION_MAX_DAYS: " " })).toBeNull();
  });

  it("fails on a value out of bounds, naming the variable", () => {
    expect(bootEnv({ STALL_BOUNCE_PERCENT: "5" }, "worker")).toContain(`STALL_BOUNCE_PERCENT can't be looser than its default, 2.5%. It's "5".`);
  });

  it("fails on a value that doesn't parse, naming the variable", () => {
    const printed = bootEnv({ FEATURE_MCP: "maybe", SESSION_DAYS: "0", ORGANIZATION_CREATION: "invite" }, "smtp");
    expect(printed).toContain(`FEATURE_MCP is on or off. It's "maybe".`);
    expect(printed).toContain(`SESSION_DAYS is a whole number from 1 to 90. It's "0".`);
    expect(printed).toContain(`ORGANIZATION_CREATION is one of closed, owners, open. It's "invite".`);
  });

  it("lists the environment's problems and the file's together", () => {
    const path = write("bulkk: true\n");
    const printed = bootEnv({ CONFIG_FILE: path, STALL_BOUNCE_COUNT: "9" });
    expect(printed).toContain("STALL_BOUNCE_COUNT can't be looser than its default, 3 bounces.");
    expect(printed).toContain("bulkk isn't a setting.");
  });
});

describe("pouch.example.yml", () => {
  it("names every setting at its default, and loads once uncommented", () => {
    const example = readFileSync(join(__dirname, "../..", "pouch.example.yml"), "utf8");
    const path = write(example.replace(/^# ([a-z_]+:)/gm, "$1"));
    const { values } = loadSettingsFile({ CONFIG_FILE: path });
    expect(Object.keys(values).sort()).toEqual([...ALL_SETTINGS].sort());
    for (const key of ALL_SETTINGS) expect(values[key], key).toBe(settingDef(key).default);
  });
});

describe("export", () => {
  const stored = { bulk: false, stall_bounce_percent: 1.3, stall_complaint_percent: 0.02, stall_bounce_count: 2, body_retention_max_days: 400, inbound: false, organization_creation: "closed" };

  it("round-trips through the loader to the same values", () => {
    const before = resolveSettings({ STALL_COUNT_VOLUME_FLOOR: "5" }, stored);
    const path = write(exportSettingsFile(ALL_SETTINGS.map((key) => before[key])), "exported.yml");

    const file = loadSettingsFile({ CONFIG_FILE: path });
    const after = resolveSettings({}, {}, file.values);
    for (const key of ALL_SETTINGS) expect(after[key].value, key).toBe(before[key].value);
  });

  it("sets only what differs from the default, so the rest stays the dashboard's", () => {
    const before = resolveSettings({ STALL_COUNT_VOLUME_FLOOR: "5" }, stored);
    const path = write(exportSettingsFile(ALL_SETTINGS.map((key) => before[key])), "exported.yml");
    expect(Object.keys(loadSettingsFile({ CONFIG_FILE: path }).values).sort()).toEqual(
      [...Object.keys(stored), "stall_count_volume_floor"].sort(),
    );
  });

  it("writes every default as a commented-out line that loads once uncommented", () => {
    const states = resolveSettings({}, {});
    const text = exportSettingsFile(
      ALL_SETTINGS.map((key) => states[key]),
      new Date("2026-10-05T12:00:00Z"),
    );
    expect(text).toContain("# Pouch settings, exported 2026-10-05T12:00:00.000Z.");
    expect(text).toContain("# Reputation\n# stall_bounce_percent: 2.5\n");
    expect(loadSettingsFile({ CONFIG_FILE: write(text, "defaults.yml") }).values).toEqual({});
    const uncommented = loadSettingsFile({ CONFIG_FILE: write(text.replace(/^# ([a-z_]+:)/gm, "$1"), "all.yml") }).values;
    expect(Object.keys(uncommented).sort()).toEqual([...ALL_SETTINGS].sort());
  });
});
