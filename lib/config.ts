// Every environment variable Pouch reads, and when it has to be set.
import { loadSettingsFile, shadowedEnv } from "@/lib/settings/file";
import { checkSettingsEnv } from "@/lib/settings/registry";
import { brand } from "@/lib/brand";

/** The processes a deployment runs. `tooling` is scripts and tests, never checked at boot. */
export type ConfigProcess = "app" | "worker" | "smtp" | "tooling";

export type ConfigCategory =
  /** Refuses to boot without it, development included. */
  | "required"
  /** Refuses to boot without it once deployed; a local checkout falls back to something workable. */
  | "deployed"
  /** Boots without it once deployed, and says what's missing. */
  | "recommended"
  /** Has a working default, or turns a feature on. */
  | "optional";

export interface ConfigVar {
  name: string;
  category: ConfigCategory;
  processes: ConfigProcess[];
  /** What happens without it, as a clause after "NAME isn't set: ". */
  effect: string;
}

const SERVICES: ConfigProcess[] = ["app", "worker", "smtp"];
const APP_WORKER: ConfigProcess[] = ["app", "worker"];
const TOOLING: ConfigProcess[] = ["tooling"];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Worker tuning variables and their defaults. `workerSetting` reads them. */
export const WORKER_DEFAULTS = {
  WORKER_HEALTH_PORT: 3101,
  WORKER_CONCURRENCY: 32,
  WORKER_POLL_INTERVAL_MS: 2000,
  WORKER_VERIFY_INTERVAL_MS: 60_000,
  WORKER_VERIFY_BATCH: 20,
  WORKER_VERIFY_RECHECK_MS: 300_000,
  WORKER_VERIFY_SLOW_RECHECK_MS: 3_600_000,
  WORKER_VERIFY_PENDING_EXPIRES_MS: 14 * DAY_MS,
  WORKER_VERIFY_VERIFIED_RECHECK_MS: DAY_MS,
  WORKER_STALL_GUARD_INTERVAL_MS: 60_000,
  WORKER_STALL_GUARD_BATCH: 50,
  WORKER_STALL_GUARD_RECHECK_MS: 300_000,
  WORKER_WEBHOOK_INTERVAL_MS: 2000,
  WORKER_WEBHOOK_BATCH: 50,
  WORKER_RETENTION_INTERVAL_MS: 60_000,
  WORKER_RETENTION_BATCH: 500,
  WORKER_ABANDON_INTERVAL_MS: 60_000,
  WORKER_ABANDON_BATCH: 500,
  WORKER_TEST_MODE_INTERVAL_MS: 2000,
  WORKER_TEST_MODE_BATCH: 500,
  WORKER_TEST_MODE_DELAY_MS: 5000,
  WORKER_EXPORT_INTERVAL_MS: 5000,
  WORKER_EXPORT_BATCH: 5,
  WORKER_EXPORT_EXPIRE_BATCH: 20,
  WORKER_INBOUND_RETENTION_INTERVAL_MS: 60_000,
  WORKER_INBOUND_RETENTION_BATCH: 500,
  WORKER_ADDRESS_EXPIRY_INTERVAL_MS: 60_000,
  WORKER_ADDRESS_EXPIRY_BATCH: 500,
  WORKER_FORWARD_INTERVAL_MS: 5000,
  WORKER_FORWARD_BATCH: 50,
  WORKER_LIST_CONFIRM_INTERVAL_MS: 10_000,
  WORKER_LIST_CONFIRM_BATCH: 50,
  WORKER_DIGEST_INTERVAL_MS: 3_600_000,
  WORKER_HEALTH_CHECK_INTERVAL_MS: 300_000,
  WORKER_BLOCKLIST_INTERVAL_MS: 3_600_000,
  WORKER_BLOCKLIST_BATCH: 500,
  WORKER_DOMAIN_STATS_INTERVAL_MS: 3_600_000,
  WORKER_ACTIVITY_RETENTION_INTERVAL_MS: 3_600_000,
  WORKER_ACTIVITY_RETENTION_BATCH: 1000,
  WORKER_HEALTH_WATCH_INTERVAL_MS: 60_000,
} as const;

export type WorkerSetting = keyof typeof WORKER_DEFAULTS;

/** A worker tuning variable from the environment, or its default. */
export function workerSetting(name: WorkerSetting, env: Record<string, string | undefined> = process.env): number {
  return Number(env[name] ?? WORKER_DEFAULTS[name]);
}

function describeDefault(value: number): string {
  if (value < DAY_MS || value % DAY_MS !== 0) return String(value);
  return value === DAY_MS ? "1 day" : `${value / DAY_MS} days`;
}

/** Read by the platform or a framework, not by Pouch's own configuration. */
export const PLATFORM_VARS = ["NODE_ENV", "NEXT_RUNTIME", "NEXT_PHASE", "VITEST", "VITEST_POOL_ID", "TZ", "HOSTNAME"];

export const CONFIG_VARS: ConfigVar[] = [
  // Core
  { name: "DATABASE_URL", category: "required", processes: [...SERVICES, "tooling"], effect: "there's no Postgres, so nothing reads or writes" },
  { name: "ENCRYPTION_KEY", category: "required", processes: SERVICES, effect: "provider credentials and sealed bodies can't be encrypted or read" },
  { name: "STORAGE_ENDPOINT", category: "required", processes: SERVICES, effect: "bodies and attachments have nowhere to go, so nothing can be accepted or sent" },
  { name: "STORAGE_BUCKET", category: "required", processes: SERVICES, effect: "bodies and attachments have nowhere to go, so nothing can be accepted or sent" },
  { name: "STORAGE_ACCESS_KEY_ID", category: "required", processes: SERVICES, effect: "the storage endpoint refuses every body read and write" },
  { name: "STORAGE_SECRET_ACCESS_KEY", category: "required", processes: SERVICES, effect: "the storage endpoint refuses every body read and write" },
  { name: "APP_URL", category: "deployed", processes: APP_WORKER, effect: "links in mail, webhook payloads and auth callbacks point at localhost" },
  { name: "BETTER_AUTH_SECRET", category: "deployed", processes: APP_WORKER, effect: "sessions, download links and list tokens can't be signed" },
  { name: "REDIS_URL", category: "deployed", processes: SERVICES, effect: "rate limits count per process, live updates stop and provider health isn't tracked" },
  { name: "GLITCHTIP_DSN", category: "recommended", processes: SERVICES, effect: "errors reach the container log and nowhere else" },

  // Optional features
  { name: "STORAGE_ASSETS_BUCKET", category: "optional", processes: SERVICES, effect: "logo upload is off and layouts carry no hosted images" },
  { name: "STORAGE_ASSETS_BASE_URL", category: "optional", processes: SERVICES, effect: "logo upload is off; set it with STORAGE_ASSETS_BUCKET" },
  { name: "NTFY_TOPIC", category: "optional", processes: SERVICES, effect: "admin push alerts are off and only logged" },
  { name: "NTFY_URL", category: "optional", processes: SERVICES, effect: "push alerts go to https://ntfy.sh" },
  { name: "NTFY_TOKEN", category: "optional", processes: SERVICES, effect: "push alerts are sent without auth" },
  { name: "SPAMHAUS_DQS_KEY", category: "optional", processes: APP_WORKER, effect: "domain blocklist checks are off" },
  { name: "MEILISEARCH_URL", category: "optional", processes: SERVICES, effect: "dashboard search runs on Postgres alone" },
  { name: "MEILISEARCH_API_KEY", category: "optional", processes: SERVICES, effect: "Meilisearch is called without a key" },
  { name: "MEILISEARCH_INDEX_PREFIX", category: "optional", processes: SERVICES, effect: "defaults to pouch_" },
  { name: "MEILISEARCH_TIMEOUT_MS", category: "optional", processes: SERVICES, effect: "defaults to 300" },
  { name: "CONFIG_FILE", category: "optional", processes: SERVICES, effect: "settings come from pouch.yml in the working directory, when it's there" },
  { name: "FEATURE_BULK", category: "optional", processes: SERVICES, effect: "Admin settings → Sending decides, on by default" },
  { name: "FEATURE_LISTS", category: "optional", processes: SERVICES, effect: "Admin settings → Sending decides, on by default" },
  { name: "FEATURE_INBOUND", category: "optional", processes: SERVICES, effect: "Admin settings → Receiving decides, on by default" },
  { name: "FEATURE_ADDRESSES", category: "optional", processes: SERVICES, effect: "Admin settings → Receiving decides, on by default" },
  { name: "FEATURE_OBSERVATIONS", category: "optional", processes: SERVICES, effect: "Admin settings → Reputation decides, on by default" },
  { name: "FEATURE_DMARC_REPORTS", category: "optional", processes: SERVICES, effect: "Admin settings → Reputation decides, on by default" },
  { name: "FEATURE_MCP", category: "optional", processes: SERVICES, effect: "Admin settings → Access decides, on by default" },
  { name: "MAX_MESSAGE_MB", category: "optional", processes: SERVICES, effect: "Admin settings → Sending decides, 30 by default" },
  { name: "KEY_RATE_LIMIT_DEFAULT", category: "optional", processes: ["app"], effect: "Admin settings → Sending decides, 3000 by default" },
  { name: "ADDRESS_LIMIT_DEFAULT", category: "optional", processes: APP_WORKER, effect: "Admin settings → Receiving decides, 500 by default" },
  { name: "ADDRESS_DAILY_MESSAGE_LIMIT_DEFAULT", category: "optional", processes: APP_WORKER, effect: "Admin settings → Receiving decides, 100 by default" },
  { name: "BODY_RETENTION_MAX_DAYS", category: "optional", processes: APP_WORKER, effect: "Admin settings → Retention decides, 365 by default" },
  { name: "INBOUND_RETENTION_MAX_DAYS", category: "optional", processes: APP_WORKER, effect: "Admin settings → Retention decides, 30 by default" },
  { name: "ACTIVITY_RETENTION_DAYS", category: "optional", processes: APP_WORKER, effect: "Admin settings → Retention decides, 730 by default" },
  { name: "ACTIVITY_CHURN_RETENTION_DAYS", category: "optional", processes: APP_WORKER, effect: "Admin settings → Retention decides, 90 by default" },
  { name: "STALL_BOUNCE_PERCENT", category: "optional", processes: APP_WORKER, effect: "Admin settings → Reputation decides, 2.5 by default" },
  { name: "STALL_COMPLAINT_PERCENT", category: "optional", processes: APP_WORKER, effect: "Admin settings → Reputation decides, 0.05 by default" },
  { name: "STALL_BOUNCE_COUNT", category: "optional", processes: APP_WORKER, effect: "Admin settings → Reputation decides, 3 by default" },
  { name: "STALL_COUNT_VOLUME_FLOOR", category: "optional", processes: APP_WORKER, effect: "Admin settings → Reputation decides, 10 by default" },
  { name: "SIGN_IN_PASSWORD", category: "optional", processes: ["app"], effect: "Admin settings → Access decides, on by default" },
  { name: "SIGN_IN_PASSKEY", category: "optional", processes: ["app"], effect: "Admin settings → Access decides, on by default" },
  { name: "SIGN_IN_MAGIC_LINK", category: "optional", processes: ["app"], effect: "Admin settings → Access decides, on by default" },
  { name: "SESSION_DAYS", category: "optional", processes: ["app"], effect: "Admin settings → Access decides, 7 by default" },
  { name: "NOTIFICATION_STANDING_AT_RISK", category: "optional", processes: APP_WORKER, effect: "Admin settings → Notifications decides, on by default" },
  { name: "NOTIFICATION_STANDING_PAUSED", category: "optional", processes: APP_WORKER, effect: "Admin settings → Notifications decides, on by default" },
  { name: "NOTIFICATION_STANDING_RESUMED", category: "optional", processes: APP_WORKER, effect: "Admin settings → Notifications decides, on by default" },
  { name: "NOTIFICATION_ACCOUNT_TARGETED", category: "optional", processes: APP_WORKER, effect: "Admin settings → Notifications decides, on by default" },
  { name: "NOTIFICATION_TAG_QUIET", category: "optional", processes: APP_WORKER, effect: "Admin settings → Notifications decides, on by default" },
  { name: "NOTIFICATION_DOMAIN_SPOOFED", category: "optional", processes: APP_WORKER, effect: "Admin settings → Notifications decides, on by default" },
  { name: "NOTIFICATION_DELIVERY_TIME", category: "optional", processes: APP_WORKER, effect: "Admin settings → Notifications decides, on by default" },
  { name: "NOTIFICATION_DMARC_POLICY_READY", category: "optional", processes: APP_WORKER, effect: "Admin settings → Notifications decides, on by default" },
  { name: "STANDING_ALERT_REPEAT_HOURS", category: "optional", processes: APP_WORKER, effect: "Admin settings → Notifications decides, 24 by default" },
  { name: "PROVIDER_BACKOFF_ALERT_MINUTES", category: "optional", processes: APP_WORKER, effect: "Admin settings → Notifications decides, 30 by default" },
  { name: "DIGEST_HOUR", category: "optional", processes: APP_WORKER, effect: "Admin settings → Notifications decides, 0 by default" },
  { name: "ORGANIZATION_CREATION", category: "optional", processes: ["app"], effect: "Admin settings → Access decides, open by default" },
  { name: "SMTP_TLS_CERT_PATH", category: "optional", processes: ["smtp"], effect: "SMTP has no certificate, so AUTH is off in production" },
  { name: "SMTP_TLS_KEY_PATH", category: "optional", processes: ["smtp"], effect: "SMTP has no certificate, so AUTH is off in production" },
  { name: "SMTP_TLS_HOST", category: "optional", processes: ["app", "smtp"], effect: "SMTP greets with the container's hostname and key pages name no SMTP host" },
  { name: "SMTP_IMPLICIT_TLS_PORT", category: "optional", processes: ["smtp"], effect: "implicit TLS (465) is off" },

  // Defaults
  { name: "GLITCHTIP_ENVIRONMENT", category: "optional", processes: SERVICES, effect: "error reports are tagged with NODE_ENV" },
  { name: "GIT_SHA", category: "optional", processes: SERVICES, effect: "error reports carry no release" },
  { name: "LOG_LEVEL", category: "optional", processes: [...SERVICES, "tooling"], effect: "defaults to info" },
  { name: "STORAGE_REGION", category: "optional", processes: SERVICES, effect: "defaults to auto" },
  { name: "STORAGE_FORCE_PATH_STYLE", category: "optional", processes: SERVICES, effect: "defaults to path-style; set false for R2" },
  { name: "STORAGE_KEY_PREFIX", category: "optional", processes: SERVICES, effect: "defaults to bodies" },
  { name: "REDIS_KEY_PREFIX", category: "optional", processes: [...SERVICES, "tooling"], effect: "keys carry no prefix" },
  { name: "SUPPORT_ADDRESS", category: "optional", processes: SERVICES, effect: "system mail's default local part and copy read support@example.org" },
  { name: "NEXT_PUBLIC_APP_URL", category: "optional", processes: ["app"], effect: "read at build; the browser calls the origin it was served from and examples use APP_URL" },
  { name: "PORT", category: "optional", processes: ["app"], effect: "defaults to 3100" },
  { name: "DNS_RESOLVERS", category: "optional", processes: APP_WORKER, effect: "published DNS is checked against 1.1.1.1 and 8.8.8.8" },
  { name: "BULK_FANOUT_THRESHOLD", category: "optional", processes: SERVICES, effect: "defaults to 200" },
  { name: "MAILPACE_API_BASE", category: "optional", processes: SERVICES, effect: "defaults to Mailpace's API" },
  { name: "CLOUDFLARE_API_BASE", category: "optional", processes: SERVICES, effect: "defaults to Cloudflare's API" },
  { name: "SES_API_RATE_PER_SECOND", category: "optional", processes: SERVICES, effect: "defaults to 1" },
  { name: "SES_API_RETRY_BASE_MS", category: "optional", processes: SERVICES, effect: "defaults to 1000" },
  { name: "SHUTDOWN_HOOK_TIMEOUT_MS", category: "optional", processes: SERVICES, effect: "defaults to 8000" },
  { name: "SHUTDOWN_DRAIN_TIMEOUT_MS", category: "optional", processes: SERVICES, effect: "defaults to 75000" },
  { name: "FAILED_AUTH_RATE_LIMIT", category: "optional", processes: ["app"], effect: "defaults to 20" },
  { name: "PASSWORD_RESET_RATE_LIMIT", category: "optional", processes: ["app"], effect: "defaults to 5" },
  { name: "PASSWORD_RESET_EMAIL_RATE_LIMIT", category: "optional", processes: ["app"], effect: "defaults to 3" },
  { name: "MAGIC_LINK_RATE_LIMIT", category: "optional", processes: ["app"], effect: "defaults to 5" },
  { name: "MAGIC_LINK_EMAIL_RATE_LIMIT", category: "optional", processes: ["app"], effect: "defaults to 3" },
  { name: "INVITE_RATE_LIMIT", category: "optional", processes: ["app"], effect: "defaults to 10" },
  { name: "INVITE_EMAIL_RATE_LIMIT", category: "optional", processes: ["app"], effect: "defaults to 3" },
  { name: "MAX_CONCURRENT_STREAMS_PER_KEY", category: "optional", processes: ["app"], effect: "defaults to 10" },
  { name: "MCP_WATCH_TIMEOUT_MS", category: "optional", processes: ["app"], effect: "defaults to 55000" },

  { name: "DATABASE_POOL_MAX", category: "optional", processes: SERVICES, effect: "each process holds up to 10 Postgres connections" },

  // SMTP tuning
  { name: "SMTP_SUBMISSION_PORT", category: "optional", processes: ["app", "smtp"], effect: "defaults to 587" },
  { name: "SMTP_HEALTH_PORT", category: "optional", processes: ["smtp"], effect: "defaults to 3102" },
  { name: "SMTP_MAX_CLIENTS", category: "optional", processes: ["smtp"], effect: "defaults to 100" },
  { name: "SMTP_MAX_MESSAGE_BYTES", category: "optional", processes: ["smtp"], effect: "defaults to 30 MB" },
  { name: "SMTP_SOCKET_TIMEOUT_MS", category: "optional", processes: ["smtp"], effect: "defaults to 60000" },

  // Worker tuning
  ...Object.entries(WORKER_DEFAULTS).map(
    ([name, fallback]): ConfigVar => ({ name, category: "optional", processes: ["worker"], effect: `defaults to ${describeDefault(fallback)}` }),
  ),

  // Seed and admin recovery, read by scripts
  { name: "ADMIN_EMAIL", category: "optional", processes: TOOLING, effect: "pnpm seed and pnpm bootstrap stop" },
  { name: "ADMIN_PASSWORD", category: "optional", processes: TOOLING, effect: "pnpm seed stops" },
  { name: "ADMIN_NAME", category: "optional", processes: TOOLING, effect: "the seeded admin is named after their address" },
  { name: "SEED_ORGANIZATION_NAME", category: "optional", processes: TOOLING, effect: "defaults to Default" },
  { name: "SEED_ORGANIZATION_SLUG", category: "optional", processes: TOOLING, effect: "defaults to default" },
  { name: "SEED_PROVIDER_ADAPTER", category: "optional", processes: TOOLING, effect: "defaults to ses" },
  { name: "SEED_PROVIDER_NAME", category: "optional", processes: TOOLING, effect: "defaults to primary" },
  { name: "SEED_PROVIDER_CREDENTIALS", category: "optional", processes: TOOLING, effect: "pnpm seed stops" },
  { name: "SEED_PROVIDER_SETTINGS", category: "optional", processes: TOOLING, effect: "the seeded provider has no settings" },
  { name: "SEED_PROVIDER_CONCURRENCY", category: "optional", processes: TOOLING, effect: "defaults to 16" },
  { name: "SEED_DOMAIN", category: "optional", processes: TOOLING, effect: "pnpm seed stops" },
  { name: "SEED_KEY_NAME", category: "optional", processes: TOOLING, effect: "defaults to bootstrap" },
  { name: "SEED_KEY_MODE", category: "optional", processes: TOOLING, effect: "defaults to live" },
  { name: "NPM_TOKEN", category: "optional", processes: TOOLING, effect: "pnpm release:sdk publishes as the npm login account" },
  { name: "RESET_ADMIN_EMAIL", category: "optional", processes: TOOLING, effect: "pnpm reset:admin stops" },
  { name: "RESET_ADMIN_PASSWORD", category: "optional", processes: TOOLING, effect: "pnpm reset:admin stops" },

  // Tests
  { name: "TEST_DATABASE_URL", category: "optional", processes: TOOLING, effect: "integration tests can't run" },
  { name: "LOAD_MESSAGES", category: "optional", processes: TOOLING, effect: "pnpm test:load sends 2000" },
  { name: "LOAD_WORKER_CONCURRENCY", category: "optional", processes: TOOLING, effect: "pnpm test:load runs the worker at 8" },
  { name: "LOAD_PROVIDER_CONCURRENCY", category: "optional", processes: TOOLING, effect: "pnpm test:load runs the provider at 4" },
  { name: "MOCK_SEND_LATENCY_MS", category: "optional", processes: TOOLING, effect: "the mock provider answers at once; pnpm test:load sets 120" },
  { name: "LOAD_BATCH", category: "optional", processes: TOOLING, effect: "pnpm test:load accepts a batch of 2000" },
  { name: "LOAD_EVENTS", category: "optional", processes: TOOLING, effect: "pnpm test:load applies 2000 delivery events" },
  { name: "LOAD_WEBHOOKS", category: "optional", processes: TOOLING, effect: "pnpm test:load delivers 1000 webhooks" },
  { name: "LOAD_REPORT", category: "optional", processes: TOOLING, effect: "pnpm test:load writes its numbers to stderr" },
  { name: "TEST_MEILISEARCH_URL", category: "optional", processes: TOOLING, effect: "the live search tests are skipped" },
  { name: "TEST_MEILISEARCH_API_KEY", category: "optional", processes: TOOLING, effect: "the live search tests call Meilisearch without a key" },
  { name: "TEST_CLOCK_SKEW_MS", category: "optional", processes: TOOLING, effect: "tests run with the app and database clocks agreeing" },
  { name: "UIKIT_REGISTRY_URL", category: "optional", processes: TOOLING, effect: "pnpm uikit can't reach the kit registry" },
];

/** Values `.env.example` ships with. A deployment running on one is running on a published secret. */
const DEVELOPMENT_VALUES: Record<string, string> = {
  BETTER_AUTH_SECRET: "pouch-development-only-session-secret",
  ENCRYPTION_KEY: "cG91Y2gtZGV2ZWxvcG1lbnQtb25seS1rZXktMzJieXQ=",
};

/** Set together or not at all. */
const PAIRS: [string, string, string][] = [
  ["STORAGE_ASSETS_BUCKET", "STORAGE_ASSETS_BASE_URL", "logo upload stays off"],
  ["SMTP_TLS_CERT_PATH", "SMTP_TLS_KEY_PATH", "SMTP starts without TLS"],
];

/** Variables no longer read, and what replaced each. Setting one warns at boot. */
export const RETIRED_VARS: { name: string; processes: ConfigProcess[]; instead: string }[] = [
  { name: "WORKER_BACKING_OFF_ALERT_MS", processes: ["worker"], instead: "Set PROVIDER_BACKOFF_ALERT_MINUTES, in minutes, or the backing-off alert in Admin settings → Notifications" },
];

export interface ConfigProblems {
  /** Refuses to boot. */
  errors: string[];
  /** Boots, and says so. */
  warnings: string[];
}

type Env = Record<string, string | undefined>;

function isSet(env: Env, name: string): boolean {
  return Boolean(env[name]?.trim());
}

function describe(entry: ConfigVar): string {
  return `${entry.name} isn't set: ${entry.effect}.`;
}

/** Whether this process runs as a deployment. The image sets NODE_ENV=production; a local checkout doesn't. */
export function isDeployed(env: Env = process.env): boolean {
  return env.NODE_ENV === "production";
}

export function checkConfig(env: Env, role: Exclude<ConfigProcess, "tooling">, deployed: boolean): ConfigProblems {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mine = CONFIG_VARS.filter((entry) => entry.processes.includes(role));

  for (const entry of mine) {
    if (isSet(env, entry.name)) continue;
    if (entry.category === "required" || (entry.category === "deployed" && deployed)) errors.push(describe(entry));
    else if (entry.category === "recommended" && deployed) warnings.push(describe(entry));
  }

  if (deployed) {
    for (const [name, value] of Object.entries(DEVELOPMENT_VALUES)) {
      if (mine.some((entry) => entry.name === name) && env[name]?.trim() === value) {
        errors.push(`${name} is the development value from .env.example. Generate one with openssl rand -base64 32.`);
      }
    }
  }

  const key = env.ENCRYPTION_KEY?.trim();
  if (key && mine.some((entry) => entry.name === "ENCRYPTION_KEY") && Buffer.from(key, "base64").length !== 32) {
    errors.push("ENCRYPTION_KEY must decode to 32 bytes of base64. Generate one with openssl rand -base64 32.");
  }

  errors.push(...checkSettingsEnv(env));

  for (const retired of RETIRED_VARS) {
    if (retired.processes.includes(role) && isSet(env, retired.name)) warnings.push(`${retired.name} is no longer read. ${retired.instead}.`);
  }

  for (const [first, second, effect] of PAIRS) {
    if (!mine.some((entry) => entry.name === first)) continue;
    if (isSet(env, first) === isSet(env, second)) continue;
    const missing = isSet(env, first) ? second : first;
    const message = `${missing} isn't set while ${missing === first ? second : first} is: ${effect}. Set both or neither.`;
    if (deployed) errors.push(message);
    else warnings.push(message);
  }

  return { errors, warnings };
}

/** Throws once, listing every problem, so a deployment missing a required variable never starts. */
export function assertConfig(env: Env, role: Exclude<ConfigProcess, "tooling">, deployed: boolean): ConfigProblems {
  const problems = checkConfig(env, role, deployed);
  if (problems.errors.length > 0) {
    throw new Error([`${brand.name} can't start:`, ...problems.errors.map((error) => `  - ${error}`)].join("\n"));
  }
  return problems;
}

/** The boot check each entry point runs first: the environment, then the settings file. Logs warnings; exits naming every error. */
export function checkBootConfig(role: Exclude<ConfigProcess, "tooling">, env: Env = process.env): void {
  const failures: string[] = [];
  try {
    const { warnings } = assertConfig(env, role, isDeployed(env));
    for (const warning of warnings) console.warn(`[config] ${warning}`);
  } catch (err) {
    failures.push((err as Error).message);
  }
  try {
    for (const warning of shadowedEnv(loadSettingsFile(env), env)) console.warn(`[config] ${warning}`);
  } catch (err) {
    failures.push((err as Error).message);
  }
  if (failures.length === 0) return;
  // A throw from Next's register() leaves the server answering 500s, so exit instead.
  console.error(`[config] ${failures.join("\n")}`);
  process.exit(1);
}
