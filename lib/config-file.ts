// A YAML config file: a mapping of keys to values, at CONFIG_FILE or a default name in the working directory.
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse, stringify } from "yaml";

export class ConfigFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigFileError";
  }
}

export interface ConfigFileLocation {
  path: string;
  /** The file's own name, for messages: "pouch.yml". */
  name: string;
  /** Named by CONFIG_FILE, so it has to exist. */
  explicit: boolean;
}

/** Where the file is: CONFIG_FILE, or `defaultName` in the working directory. */
export function locateConfigFile(defaultName: string, env: Record<string, string | undefined> = process.env): ConfigFileLocation {
  const named = env.CONFIG_FILE?.trim();
  const path = resolve(process.cwd(), named || defaultName);
  return { path, name: basename(path), explicit: Boolean(named) };
}

/** The file's top-level mapping, or null when it isn't there and didn't have to be. Throws when it can't be read or parsed. */
export function readConfigFile(location: ConfigFileLocation): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(location.path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !location.explicit) return null;
    if (code === "ENOENT") throw new ConfigFileError(`${location.path} doesn't exist, and CONFIG_FILE names it.`);
    if (code === "EISDIR") throw new ConfigFileError(`${location.path} is a directory, not a file.`);
    throw new ConfigFileError(`${location.path} can't be read: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new ConfigFileError(`${location.path} isn't valid YAML: ${(error as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigFileError(`${location.path} has to be a mapping of keys to values.`);
  }
  return parsed as Record<string, unknown>;
}

export interface ConfigFileEntry {
  key: string;
  value: unknown;
  /** Written as a comment: shown, not set. */
  commented?: boolean;
}

export interface ConfigFileGroup {
  /** A comment line above the group's first key. */
  comment?: string;
  entries: ConfigFileEntry[];
}

/** YAML the reader takes back: groups of keys under their comments, with a header on top. */
export function stringifyConfigFile(groups: ConfigFileGroup[], header?: string): string {
  const blocks = groups
    .filter((group) => group.entries.length > 0)
    .map((group) => {
      const lines = group.comment ? [`# ${group.comment}`] : [];
      for (const entry of group.entries) {
        const text = stringify({ [entry.key]: entry.value }).trimEnd().split("\n");
        lines.push(...(entry.commented ? text.map((line) => `# ${line}`) : text));
      }
      return lines.join("\n");
    });
  const head = header?.split("\n").map((line) => (line ? `# ${line}` : "#")).join("\n");
  return `${[head, ...blocks].filter(Boolean).join("\n\n")}\n`;
}
