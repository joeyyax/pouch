/** pouch.yml: registry values an operator pins in a file, checked at boot and read after the environment. */
import { ConfigFileError, locateConfigFile, readConfigFile, stringifyConfigFile, type ConfigFileLocation } from "@/lib/config-file";
import { ALL_SETTINGS, isSettingKey, parseSettingValue, SETTING_SECTIONS, settingDef, settingValueProblem, type SettingKey, type SettingState } from "./registry";
import { brand } from "@/lib/brand";

export const SETTINGS_FILE = "pouch.yml";

export type FileValues = Partial<Record<SettingKey, boolean | number | string>>;

export interface SettingsFile extends ConfigFileLocation {
  values: FileValues;
}

type Env = Record<string, string | undefined>;

/** The file's values by key, and every key or value the registry refuses, each naming its key. */
export function checkSettingsFile(raw: Record<string, unknown>): { values: FileValues; errors: string[] } {
  const values: FileValues = {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!isSettingKey(key)) {
      const byEnv = ALL_SETTINGS.find((entry) => settingDef(entry).env === key);
      if (byEnv) errors.push(`${key} is the environment variable; the file names it ${byEnv}.`);
      else if (/^[A-Z][A-Z0-9_]*$/.test(key)) errors.push(`${key} isn't a setting. Environment variables, secrets included, stay in the environment.`);
      else errors.push(`${key} isn't a setting.`);
      continue;
    }
    const def = settingDef(key);
    const parsed = parseSettingValue(def, value);
    if (parsed === undefined) errors.push(settingValueProblem(key, def, value)!);
    else values[key] = parsed;
  }
  return { values, errors };
}

/** Reads and checks the file. Throws once, naming every problem. */
export function loadSettingsFile(env: Env = process.env): SettingsFile {
  const location = locateConfigFile(SETTINGS_FILE, env);
  const raw = readConfigFile(location);
  if (raw === null) return { ...location, values: {} };
  const { values, errors } = checkSettingsFile(raw);
  if (errors.length > 0) {
    throw new ConfigFileError([`${location.path} has settings ${brand.name} can't use:`, ...errors.map((error) => `  - ${error}`)].join("\n"));
  }
  return { ...location, values };
}

/** A line for each environment variable that overrides the file. */
export function shadowedEnv(file: SettingsFile, env: Env = process.env): string[] {
  return (Object.keys(file.values) as SettingKey[])
    .filter((key) => env[settingDef(key).env]?.trim())
    .map((key) => `${settingDef(key).env} overrides ${file.name}'s ${key}.`);
}

let cached: SettingsFile | undefined;

/** The file this process booted with. Read once, so a change takes a restart, the way the environment does. */
export function settingsFile(): SettingsFile {
  // Tests name their file; a checkout's own pouch.yml stays out of them.
  if (process.env.VITEST && !process.env.CONFIG_FILE?.trim()) return { ...locateConfigFile(SETTINGS_FILE), values: {} };
  cached ??= loadSettingsFile();
  return cached;
}

/** Forgets the file read, for tests that change it. */
export function forgetSettingsFile(): void {
  cached = undefined;
}

/** Settings as YAML in the file's shape: a value off its default is set, a default is commented out. The registry holds no secrets. */
export function exportSettingsFile(states: SettingState[], exportedAt = new Date()): string {
  const groups = SETTING_SECTIONS.map((section) => ({
    comment: section.label,
    entries: states
      .filter((state) => state.def.section === section.id)
      .map((state) => ({ key: state.key, value: state.value, commented: state.value === state.def.default })),
  }));
  return stringifyConfigFile(
    groups,
    `${brand.name} settings, exported ${exportedAt.toISOString()}.\nA set value locks its setting in Admin settings. A commented-out line is the default.`,
  );
}
