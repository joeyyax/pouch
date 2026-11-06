import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_VARS, PLATFORM_VARS } from "@/lib/config";

// Every process that stores and encrypts a message body needs the same storage and
// encryption env. mail-smtp shipped without it once (#8) because nothing enforced that the
// three services stay in sync — this test is that enforcement, not the compose file's own
// `<<: *mail-env` merge, which YAML resolves for us but nothing here re-checks. Each file defines
// the services in full; the Traefik file repeats self-host rather than including it.
const FILES = ["docker-compose.self-host.yml", "docker-compose.traefik.yml", "docker-compose.vardo-production.yml"] as const;

const ROLES = ["app", "worker", "smtp"] as const;
type Role = (typeof ROLES)[number];

const LEGACY_NAMES: Record<Role, string> = { app: "mail", worker: "mail-worker", smtp: "mail-smtp" };

/** Each file's service name for a role. Vardo's file uses the pouch names. */
const SERVICE_NAMES: Record<(typeof FILES)[number], Record<Role, string>> = {
  "docker-compose.self-host.yml": LEGACY_NAMES,
  "docker-compose.traefik.yml": LEGACY_NAMES,
  "docker-compose.vardo-production.yml": { app: "pouch", worker: "pouch-worker", smtp: "pouch-smtp" },
};

function read(file: string): string {
  return readFileSync(join(__dirname, "../..", file), "utf8");
}

const REQUIRED_SHARED_VARS = [
  "ENCRYPTION_KEY",
  "STORAGE_ENDPOINT",
  "STORAGE_BUCKET",
  "STORAGE_REGION",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_FORCE_PATH_STYLE",
];

/** The `x-mail-env: &mail-env` anchor block, up to the next top-level key. */
function sharedEnvBlock(compose: string): string {
  const start = compose.indexOf("x-mail-env: &mail-env");
  expect(start).toBeGreaterThan(-1);
  const end = compose.indexOf("\nservices:", start);
  expect(end).toBeGreaterThan(start);
  return compose.slice(start, end);
}

/** One service's block, from its top-level key up to the next top-level service key. */
function serviceBlock(compose: string, name: string): string {
  const marker = `\n  ${name}:\n`;
  const start = compose.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const next = compose.slice(start + marker.length).search(/\n {2}\S/);
  const end = next === -1 ? compose.length : start + marker.length + next;
  return compose.slice(start, end);
}

describe.each(FILES)("%s env parity", (file) => {
  const compose = read(file);

  it("defines every storage and encryption var mail-smtp needs on the shared x-mail-env anchor", () => {
    const shared = sharedEnvBlock(compose);
    for (const name of REQUIRED_SHARED_VARS) {
      expect(shared).toContain(`${name}:`);
    }
  });

  it.each(ROLES)("the %s service merges the shared anchor instead of repeating storage and encryption vars", (role) => {
    const block = serviceBlock(compose, SERVICE_NAMES[file][role]);
    expect(block).toContain("<<: *mail-env");
    // Repeating one of the shared keys directly on the service (rather than relying on the
    // merge) is exactly how mail-smtp drifted from mail and mail-worker before #8.
    for (const varName of REQUIRED_SHARED_VARS) {
      const ownDefinition = new RegExp(`\\n {6}${varName}:`);
      expect(block).not.toMatch(ownDefinition);
    }
  });
});

// The deployments carry the same services; only the proxy around them differs. A variable
// added to one and forgotten in another is the drift this catches.
describe("the deployment files carry the same service environment", () => {
  it.each(ROLES)("the %s service names the same variables in each", (role) => {
    const names = (file: (typeof FILES)[number]) =>
      [...serviceBlock(read(file), SERVICE_NAMES[file][role]).matchAll(/\n {6}([A-Z][A-Z0-9_]*):/g)].map(([, key]) => key).sort();
    const [selfHost, ...others] = FILES.map(names);
    for (const other of others) expect(other).toEqual(selfHost);
  });
});

/** Every variable a service sees: the shared anchor plus its own block. */
function serviceVars(compose: string, name: string): string[] {
  const own = [...serviceBlock(compose, name).matchAll(/\n {6}([A-Z][A-Z0-9_]*):/g)].map(([, key]) => key!);
  const shared = [...sharedEnvBlock(compose).matchAll(/\n {2}([A-Z][A-Z0-9_]*):/g)].map(([, key]) => key!);
  return [...shared, ...own];
}

// lib/config.ts refuses to boot without these, so a service that doesn't pass one through can't start.
describe.each(FILES)("%s against lib/config.ts", (file) => {
  const compose = read(file);
  const known = new Set([...CONFIG_VARS.map((entry) => entry.name), ...PLATFORM_VARS]);

  it.each(ROLES)("the %s service passes through every variable its process needs", (role) => {
    const names = new Set(serviceVars(compose, SERVICE_NAMES[file][role]));
    const needed = CONFIG_VARS.filter(
      (entry) => entry.processes.includes(role) && (entry.category === "required" || entry.category === "deployed"),
    ).map((entry) => entry.name);
    expect(needed.filter((name) => !names.has(name))).toEqual([]);
  });

  it.each(ROLES)("the %s service names only variables the registry knows", (role) => {
    expect(serviceVars(compose, SERVICE_NAMES[file][role]).filter((name) => !known.has(name))).toEqual([]);
  });
});
