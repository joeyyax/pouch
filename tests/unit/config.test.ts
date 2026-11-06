import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_VARS, PLATFORM_VARS, assertConfig, checkConfig } from "@/lib/config";

const ROOT = join(__dirname, "../..");

/** A deployed app with nothing missing. */
const COMPLETE = {
  DATABASE_URL: "postgresql://mail:pw@postgres:5432/mail",
  REDIS_URL: "redis://redis:6379",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  BETTER_AUTH_SECRET: "a-real-secret",
  APP_URL: "https://pouch.email",
  STORAGE_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  STORAGE_BUCKET: "bodies",
  STORAGE_ACCESS_KEY_ID: "key",
  STORAGE_SECRET_ACCESS_KEY: "secret",
  GLITCHTIP_DSN: "https://key@glitchtip.example/1",
};

/** The smallest thing that boots on a laptop. */
const LOCAL = {
  DATABASE_URL: "postgresql://mail:mail@localhost:5440/mail",
  ENCRYPTION_KEY: "cG91Y2gtZGV2ZWxvcG1lbnQtb25seS1rZXktMzJieXQ=",
  STORAGE_ENDPOINT: "http://localhost:9010",
  STORAGE_BUCKET: "mail-bodies",
  STORAGE_ACCESS_KEY_ID: "minioadmin",
  STORAGE_SECRET_ACCESS_KEY: "minioadmin",
};

function mentions(messages: string[], name: string): boolean {
  return messages.some((message) => message.includes(name));
}

describe("a complete environment", () => {
  it.each(["app", "worker", "smtp"] as const)("reports nothing for %s when deployed", (role) => {
    expect(checkConfig(COMPLETE, role, true)).toEqual({ errors: [], warnings: [] });
  });

  it.each(["app", "worker", "smtp"] as const)("reports nothing for %s on a laptop with the core set", (role) => {
    expect(checkConfig(LOCAL, role, false)).toEqual({ errors: [], warnings: [] });
  });
});

describe("required everywhere", () => {
  it("refuses a missing or blank core variable, even locally", () => {
    for (const name of ["DATABASE_URL", "ENCRYPTION_KEY", "STORAGE_BUCKET", "STORAGE_ENDPOINT"]) {
      expect(mentions(checkConfig({ ...LOCAL, [name]: undefined }, "app", false).errors, name), name).toBe(true);
      expect(mentions(checkConfig({ ...LOCAL, [name]: "  " }, "smtp", false).errors, name), name).toBe(true);
    }
  });

  it("refuses an encryption key that isn't 32 bytes", () => {
    const { errors } = checkConfig({ ...LOCAL, ENCRYPTION_KEY: "c2hvcnQ=" }, "worker", false);
    expect(mentions(errors, "32 bytes")).toBe(true);
  });
});

describe("required once deployed", () => {
  it("refuses APP_URL, BETTER_AUTH_SECRET and REDIS_URL on the app and worker", () => {
    for (const role of ["app", "worker"] as const) {
      for (const name of ["APP_URL", "BETTER_AUTH_SECRET", "REDIS_URL"]) {
        expect(mentions(checkConfig({ ...COMPLETE, [name]: "" }, role, true).errors, name), `${role} ${name}`).toBe(true);
      }
    }
  });

  it("doesn't ask SMTP for what it never reads", () => {
    const { errors } = checkConfig({ ...COMPLETE, APP_URL: undefined, BETTER_AUTH_SECRET: undefined }, "smtp", true);
    expect(errors).toEqual([]);
  });

  it("lets a laptop run without them", () => {
    expect(checkConfig(LOCAL, "app", false).errors).toEqual([]);
  });

  it("refuses the development secrets from .env.example", () => {
    const { errors } = checkConfig(
      { ...COMPLETE, BETTER_AUTH_SECRET: "pouch-development-only-session-secret", ENCRYPTION_KEY: LOCAL.ENCRYPTION_KEY },
      "app",
      true,
    );
    expect(mentions(errors, "BETTER_AUTH_SECRET")).toBe(true);
    expect(mentions(errors, "ENCRYPTION_KEY")).toBe(true);
  });
});

describe("recommended and optional", () => {
  it("warns about error reporting when deployed, without refusing", () => {
    const { errors, warnings } = checkConfig({ ...COMPLETE, GLITCHTIP_DSN: undefined }, "worker", true);
    expect(errors).toEqual([]);
    expect(mentions(warnings, "GLITCHTIP_DSN")).toBe(true);
  });

  it("says nothing about a feature that's simply off", () => {
    expect(checkConfig({ ...COMPLETE, SPAMHAUS_DQS_KEY: undefined, STORAGE_ASSETS_BUCKET: undefined }, "app", true)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("refuses half an assets bucket when deployed, and warns locally", () => {
    const half = { STORAGE_ASSETS_BUCKET: "assets" };
    expect(mentions(checkConfig({ ...COMPLETE, ...half }, "app", true).errors, "STORAGE_ASSETS_BASE_URL")).toBe(true);
    const local = checkConfig({ ...LOCAL, ...half }, "app", false);
    expect(local.errors).toEqual([]);
    expect(mentions(local.warnings, "STORAGE_ASSETS_BASE_URL")).toBe(true);
  });
});

describe("retired variables", () => {
  it("warns a worker that still sets WORKER_BACKING_OFF_ALERT_MS, naming the replacement", () => {
    const { errors, warnings } = checkConfig({ ...COMPLETE, WORKER_BACKING_OFF_ALERT_MS: "1800000" }, "worker", true);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      "WORKER_BACKING_OFF_ALERT_MS is no longer read. Set PROVIDER_BACKOFF_ALERT_MINUTES, in minutes, or the backing-off alert in Admin settings → Notifications.",
    ]);
  });

  it("says nothing when it's unset", () => {
    expect(checkConfig(COMPLETE, "worker", true).warnings).toEqual([]);
  });
});

describe("assertConfig", () => {
  it("throws once, listing every problem", () => {
    expect(() => assertConfig({}, "app", true)).toThrowError(/DATABASE_URL[\s\S]*ENCRYPTION_KEY[\s\S]*APP_URL/);
  });

  it("returns warnings rather than throwing on them", () => {
    expect(mentions(assertConfig({ ...COMPLETE, GLITCHTIP_DSN: undefined }, "app", true).warnings, "GLITCHTIP_DSN")).toBe(true);
  });
});

describe("the registry", () => {
  it("names each variable once", () => {
    const names = CONFIG_VARS.map((entry) => entry.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it("matches .env.example exactly, commented-out lines included", () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    const documented = example
      .split("\n")
      .map((line) => /^(?:# ?)?([A-Z][A-Z0-9_]+)=/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name));
    expect(new Set(documented)).toEqual(new Set(CONFIG_VARS.map((entry) => entry.name)));
  });

  it("covers every variable the source reads", () => {
    const known = new Set([...CONFIG_VARS.map((entry) => entry.name), ...PLATFORM_VARS]);
    const unknown = new Map<string, string>();
    for (const file of sourceFiles()) {
      for (const name of readsIn(readFileSync(file, "utf8"))) {
        if (!known.has(name)) unknown.set(name, relative(ROOT, file));
      }
    }
    expect(Object.fromEntries(unknown)).toEqual({});
  });
});

const SOURCE_DIRS = ["app", "lib", "worker", "smtp", "scripts", "tests"];
const SOURCE_FILES = ["instrumentation.ts", "next.config.ts", "drizzle.config.ts"];

function sourceFiles(): string[] {
  const files = SOURCE_FILES.map((file) => join(ROOT, file));
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) files.push(path);
    }
  };
  for (const dir of SOURCE_DIRS) walk(join(ROOT, dir));
  return files;
}

/** Direct env reads, bracketed ones and the scripts' `required` helper. */
function readsIn(source: string): string[] {
  const pattern = /process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[\s*"([A-Z][A-Z0-9_]+)"\s*\]|\brequired\("([A-Z][A-Z0-9_]+)"\)|\benv\.([A-Z][A-Z0-9_]+)/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3] ?? match[4]!);
}
