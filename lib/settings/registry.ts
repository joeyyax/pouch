// Every install-wide setting an operator can change: its type, bounds, default and environment variable.
import { RATE_FLOOR } from "@/lib/metrics/rates";
import { INBOUND_RETENTION_DEFAULT_MAX_DAYS, INBOUND_RETENTION_HARD_MAX_DAYS } from "@/lib/inbound/constants";
import { SIGN_IN_FLOOR_DAYS } from "@/lib/activity/windows";
import { MAX_MESSAGE_MB } from "@/lib/messages/size";
import { ADDRESS_DAILY_MESSAGE_LIMIT_DEFAULT, ADDRESS_LIMIT_DEFAULT } from "@/lib/addresses/constants";

export type SettingSection = "sending" | "reputation" | "receiving" | "monitoring" | "notifications" | "access" | "retention";

/** An Admin settings tab that holds registry sections. */
export type SettingPage = "sending" | "receiving" | "reputation" | "notifications" | "access" | "retention";

export const SETTING_PAGES: { id: SettingPage; label: string }[] = [
  { id: "sending", label: "Sending" },
  { id: "receiving", label: "Receiving" },
  { id: "reputation", label: "Reputation" },
  { id: "notifications", label: "Notifications" },
  { id: "access", label: "Access" },
  { id: "retention", label: "Retention" },
];

/** Section order, copy and the Admin settings tab each sits on. */
export const SETTING_SECTIONS: { id: SettingSection; page: SettingPage; label: string; description: string }[] = [
  { id: "sending", page: "sending", label: "Sending", description: "Bulk mail, how large a message can be and how fast a new key sends." },
  { id: "reputation", page: "reputation", label: "Reputation", description: "When the reputation guard pauses a domain's queue. Each line goes lower than its default, never higher." },
  { id: "receiving", page: "receiving", label: "Receiving", description: "Mail that arrives on a domain's inbound host." },
  { id: "monitoring", page: "reputation", label: "Monitoring", description: "What the overview and the digest read from send metadata." },
  { id: "notifications", page: "notifications", label: "Notifications", description: "Email to organization owners and admins. A type off here goes to nobody on the install." },
  { id: "access", page: "access", label: "Access", description: "Who gets in, how and for how long." },
  { id: "retention", page: "retention", label: "Retention", description: "How long message bodies, inbound mail and the activity log are kept." },
];

/** Where an entry is changed in the dashboard, such as "Admin settings → Sending". */
export function settingLocation(section: SettingSection): string {
  const page = SETTING_SECTIONS.find((entry) => entry.id === section)!.page;
  return `Admin settings → ${SETTING_PAGES.find((entry) => entry.id === page)!.label}`;
}

interface BaseDef {
  section: SettingSection;
  label: string;
  description: string;
  env: string;
  /** Set by its environment variable only, never shown in the dashboard. */
  configOnly?: boolean;
  /** The feature this one can't work without. While that one is off, a boolean is off and anything else is unavailable. */
  dependsOn?: string;
  /** Read when the app starts, so a change waits for a restart. */
  restart?: boolean;
}

export type SettingDef =
  | (BaseDef & { type: "boolean"; default: boolean; feature?: true })
  | (BaseDef & { type: "integer"; default: number; min: number; max: number; unit: string })
  | (BaseDef & { type: "decimal"; default: number; min: number; max: number; step: number; unit: string })
  | (BaseDef & { type: "enum"; default: string; options: readonly string[]; optionLabels?: Record<string, string> });

function notification(label: string, env: string, description: string, dependsOn?: string) {
  return { type: "boolean", default: true, section: "notifications", label, env, description, ...(dependsOn ? { dependsOn } : {}) } as const;
}

function feature(section: SettingSection, label: string, env: string, description: string, dependsOn?: string) {
  return { type: "boolean", feature: true, default: true, section, label, env, description, ...(dependsOn ? { dependsOn } : {}) } as const;
}

export const SETTINGS = {
  bulk: feature("sending", "Bulk", "FEATURE_BULK", "Batches to many recipients, each with a signed unsubscribe link. Each domain still opts in on its own."),
  lists: feature(
    "sending",
    "Lists",
    "FEATURE_LISTS",
    "Subscriber lists with double opt-in, imports and exports. Unsubscribe links in mail already sent keep working.",
    "bulk",
  ),
  max_message_mb: {
    type: "integer",
    section: "sending",
    label: "Largest message",
    env: "MAX_MESSAGE_MB",
    description: "Body and decoded attachments together. Each provider's own limit still applies under it.",
    default: MAX_MESSAGE_MB,
    min: 1,
    max: MAX_MESSAGE_MB,
    unit: "MB",
  },
  key_rate_limit_default: {
    type: "integer",
    section: "sending",
    label: "Rate limit for new keys",
    env: "KEY_RATE_LIMIT_DEFAULT",
    description: "Requests a minute a key gets when it's created without one. Existing keys keep theirs.",
    default: 3000,
    min: 1,
    max: 10_000,
    unit: "requests a minute",
  },
  stall_bounce_percent: {
    type: "decimal",
    section: "reputation",
    label: "Pause bounce rate",
    env: "STALL_BOUNCE_PERCENT",
    description: "A domain's queue holds when its bounce rate passes this, or is on course to.",
    default: 2.5,
    min: 0.5,
    max: 2.5,
    step: 0.1,
    unit: "%",
  },
  stall_complaint_percent: {
    type: "decimal",
    section: "reputation",
    label: "Pause complaint rate",
    env: "STALL_COMPLAINT_PERCENT",
    description: "A domain's queue holds when its complaint rate passes this, or is on course to.",
    default: 0.05,
    min: 0.01,
    max: 0.05,
    step: 0.01,
    unit: "%",
  },
  stall_bounce_count: {
    type: "integer",
    section: "reputation",
    label: "Pause bounce count",
    env: "STALL_BOUNCE_COUNT",
    description: `Below ${RATE_FLOOR} resolved messages, too few for a rate, this many bounces holds the queue.`,
    default: 3,
    min: 1,
    max: 3,
    unit: "bounces",
  },
  stall_count_volume_floor: {
    type: "integer",
    section: "reputation",
    label: "Count guard floor",
    env: "STALL_COUNT_VOLUME_FLOOR",
    description: "Resolved messages a domain needs before a bounce count, or one complaint, holds its queue.",
    default: 10,
    min: 1,
    max: 10,
    unit: "messages",
  },
  inbound: feature(
    "receiving",
    "Inbound",
    "FEATURE_INBOUND",
    "Mail to a domain's inbound host, stored and posted to its webhook. While it's off, arriving mail is dropped.",
  ),
  addresses: feature(
    "receiving",
    "Addresses",
    "FEATURE_ADDRESSES",
    "Addresses code creates on an inbound host, with replies and forwarding. While it's off, their mail is dropped.",
    "inbound",
  ),
  address_limit_default: {
    type: "integer",
    section: "receiving",
    label: "Addresses per organization",
    env: "ADDRESS_LIMIT_DEFAULT",
    description: "Active addresses an organization may hold, unless an admin set its own in Admin settings → Organizations.",
    default: ADDRESS_LIMIT_DEFAULT,
    min: 1,
    max: 1_000_000,
    unit: "addresses",
    dependsOn: "addresses",
  },
  address_daily_message_limit_default: {
    type: "integer",
    section: "receiving",
    label: "Messages per address a day",
    env: "ADDRESS_DAILY_MESSAGE_LIMIT_DEFAULT",
    description: "Mail one address takes per UTC day before the rest is dropped, unless an admin set the organization's own.",
    default: ADDRESS_DAILY_MESSAGE_LIMIT_DEFAULT,
    min: 1,
    max: 1_000_000,
    unit: "messages",
    dependsOn: "addresses",
  },
  observations: feature("monitoring", "Observations", "FEATURE_OBSERVATIONS", "Patterns in send metadata, on the overview and in the digest."),
  dmarc_reports: feature(
    "monitoring",
    "DMARC reports",
    "FEATURE_DMARC_REPORTS",
    "Aggregate reports on the report host, the address in each domain's DMARC record and what they raise. While it's off, report mail is dropped.",
  ),
  mcp: feature("access", "MCP", "FEATURE_MCP", "The Model Context Protocol endpoint at /mcp, serving the API's routes as tools."),
  sign_in_password: {
    type: "boolean",
    section: "access",
    label: "Password sign-in",
    env: "SIGN_IN_PASSWORD",
    description: "An email and password on /login, and the reset that goes with it.",
    default: true,
  },
  sign_in_passkey: {
    type: "boolean",
    section: "access",
    label: "Passkey sign-in",
    env: "SIGN_IN_PASSKEY",
    description: "A passkey on /login, offered in the email field too.",
    default: true,
  },
  sign_in_magic_link: {
    type: "boolean",
    section: "access",
    label: "Sign-in links",
    env: "SIGN_IN_MAGIC_LINK",
    description: "A link emailed from the system from address. It never creates an account.",
    default: true,
  },
  session_days: {
    type: "integer",
    section: "access",
    label: "Session length",
    env: "SESSION_DAYS",
    description: "How long a session lasts without use.",
    default: 7,
    min: 1,
    max: 90,
    unit: "days",
    restart: true,
  },
  organization_creation: {
    type: "enum",
    section: "access",
    label: "Who creates organizations",
    env: "ORGANIZATION_CREATION",
    description: "Admins always can, in Admin settings → Organizations and on the admin API.",
    default: "open",
    options: ["closed", "owners", "open"],
    optionLabels: { closed: "Admins only", owners: "Admins and organization owners", open: "Anyone signed in" },
  },
  body_retention_max_days: {
    type: "integer",
    section: "retention",
    label: "Body retention ceiling",
    env: "BODY_RETENTION_MAX_DAYS",
    description: "The most days an organization can keep message bodies readable. Above 365, move the bucket's lifecycle rule past it first.",
    default: 365,
    min: 7,
    max: 730,
    unit: "days",
  },
  inbound_retention_max_days: {
    type: "integer",
    section: "retention",
    label: "Inbound retention ceiling",
    env: "INBOUND_RETENTION_MAX_DAYS",
    description: "The most days a domain can hold inbound mail. A domain set higher is purged at this.",
    default: INBOUND_RETENTION_DEFAULT_MAX_DAYS,
    min: 1,
    max: INBOUND_RETENTION_HARD_MAX_DAYS,
    unit: "days",
  },
  activity_retention_days: {
    type: "integer",
    section: "retention",
    label: "Activity log: setup changes",
    env: "ACTIVITY_RETENTION_DAYS",
    description: "Keys, domains, members, providers, webhooks and admin settings. Organizations created, deleted or suspended and admin grants stay for good.",
    default: 730,
    min: 365,
    max: 1825,
    unit: "days",
  },
  activity_churn_retention_days: {
    type: "integer",
    section: "retention",
    label: "Activity log: routine events",
    env: "ACTIVITY_CHURN_RETENTION_DAYS",
    description: `Pauses, DNS changes, provider findings, list members and sign-ins. Sign-ins stay at least ${SIGN_IN_FLOOR_DAYS} days.`,
    default: 90,
    min: 7,
    max: 730,
    unit: "days",
  },
  notification_standing_at_risk: notification(
    "At risk",
    "NOTIFICATION_STANDING_AT_RISK",
    "A domain or organization nears a pause, lands on a blocklist or sends unusually.",
  ),
  notification_standing_paused: notification("Sending paused", "NOTIFICATION_STANDING_PAUSED", "A domain or organization stops sending."),
  notification_standing_resumed: notification("Sending resumed", "NOTIFICATION_STANDING_RESUMED", "A paused domain or organization sends again."),
  notification_account_targeted: notification(
    "Targeted account",
    "NOTIFICATION_ACCOUNT_TARGETED",
    "One address gets an unusual number of sensitive messages.",
    "observations",
  ),
  notification_tag_quiet: notification("Tag gone quiet", "NOTIFICATION_TAG_QUIET", "A tag that sends every day sends nothing for a day.", "observations"),
  notification_domain_spoofed: notification(
    "Sending as your domain",
    "NOTIFICATION_DOMAIN_SPOOFED",
    "DMARC reports show someone else sending as a domain.",
    "observations",
  ),
  notification_delivery_time: notification("Slow delivery", "NOTIFICATION_DELIVERY_TIME", "A domain's mail takes far longer to deliver than usual."),
  notification_dmarc_policy_ready: notification(
    "Ready for p=quarantine",
    "NOTIFICATION_DMARC_POLICY_READY",
    "A domain's DMARC reports have read healthy long enough to tighten its policy.",
    "dmarc_reports",
  ),
  standing_alert_repeat_hours: {
    type: "integer",
    section: "notifications",
    label: "Standing repeat window",
    env: "STANDING_ALERT_REPEAT_HOURS",
    description: "Owners aren't emailed again for a standing they were emailed about this recently. A worse standing always emails.",
    default: 24,
    min: 1,
    max: 168,
    unit: "hours",
  },
  provider_backoff_alert_minutes: {
    type: "integer",
    section: "notifications",
    label: "Backing-off alert",
    env: "PROVIDER_BACKOFF_ALERT_MINUTES",
    description: "Admins get an alert when a provider has backed off this long with no successful send.",
    default: 30,
    min: 15,
    max: 1440,
    unit: "minutes",
  },
  digest_hour: {
    type: "integer",
    section: "notifications",
    label: "Digest hour",
    env: "DIGEST_HOUR",
    description: "When admins' daily, weekly and monthly digests send. Each covers the UTC day, week or month before.",
    default: 0,
    min: 0,
    max: 23,
    unit: "UTC",
  },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;

export const ALL_SETTINGS = Object.keys(SETTINGS) as SettingKey[];

interface TypeValues {
  boolean: boolean;
  integer: number;
  decimal: number;
  enum: string;
}

export type SettingValue<K extends SettingKey> = TypeValues[(typeof SETTINGS)[K]["type"]];

/** The optional features: boolean entries made by `feature()`. */
export type Feature = { [K in SettingKey]: (typeof SETTINGS)[K] extends { feature: true } ? K : never }[SettingKey];

export function isSettingKey(value: string): value is SettingKey {
  return Object.hasOwn(SETTINGS, value);
}

export function isFeature(value: string): value is Feature {
  if (!isSettingKey(value)) return false;
  const def = settingDef(value);
  return def.type === "boolean" && def.feature === true;
}

export function settingDef(key: SettingKey): SettingDef {
  return SETTINGS[key];
}

/** Where a setting's value came from. */
export type SettingSource = "file" | "env" | "settings" | "default";

export interface SettingState {
  key: SettingKey;
  def: SettingDef;
  /** Its own value, before what it depends on. */
  value: boolean | number | string;
  source: SettingSource;
  /** False while what it depends on is off. A boolean that isn't available reads as off. */
  available: boolean;
  dependsOn: { key: SettingKey; label: string } | null;
}

/** Decimal places in a step: 0.01 has 2. */
function stepDigits(step: number): number {
  return String(step).split(".")[1]?.length ?? 0;
}

/** A number with its entry's unit: "2.5%", "3 bounces". */
export function formatSettingValue(def: Extract<SettingDef, { unit: string }>, value: number): string {
  return def.type === "decimal" ? `${value}${def.unit}` : `${value} ${def.unit}`;
}

const TRUTHY = new Set(["1", "true", "on", "yes"]);
const FALSY = new Set(["0", "false", "off", "no"]);

/** A value the entry accepts, or undefined. Strings are parsed the way an environment variable reads. */
export function parseSettingValue(def: SettingDef, raw: unknown): boolean | number | string | undefined {
  if (def.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (typeof raw !== "string") return undefined;
    const word = raw.trim().toLowerCase();
    return TRUTHY.has(word) ? true : FALSY.has(word) ? false : undefined;
  }
  if (def.type === "integer") {
    const number = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*-?\d+\s*$/.test(raw) ? Number(raw) : NaN;
    return Number.isInteger(number) && number >= def.min && number <= def.max ? number : undefined;
  }
  if (def.type === "decimal") {
    const number = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d*\.?\d+\s*$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(number) || number < def.min || number > def.max) return undefined;
    const steps = number / def.step;
    return Math.abs(steps - Math.round(steps)) < 1e-9 ? Number((Math.round(steps) * def.step).toFixed(stepDigits(def.step))) : undefined;
  }
  return typeof raw === "string" && def.options.includes(raw.trim()) ? raw.trim() : undefined;
}

/** Why a value doesn't fit the entry, as a predicate after its name: "is a whole number from 7 to 730". */
export function settingProblem(def: SettingDef, raw: unknown): string {
  if ((def.type === "integer" || def.type === "decimal") && def.max === def.default && Number(raw) > def.max) {
    return `can't be looser than its default, ${formatSettingValue(def, def.max)}`;
  }
  if (def.type === "integer") return `is a whole number from ${def.min} to ${def.max}`;
  if (def.type === "decimal") {
    return `is from ${formatSettingValue(def, def.min)} to ${formatSettingValue(def, def.max)} in steps of ${formatSettingValue(def, def.step)}`;
  }
  if (def.type === "enum") return `is one of ${def.options.join(", ")}`;
  return "is on or off";
}

/** Why a value from the environment or the config file can't stand for the entry, under the name it was set by. Undefined when it parses. */
export function settingValueProblem(name: string, def: SettingDef, raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return `${name} has no value.`;
  if (parseSettingValue(def, raw) !== undefined) return undefined;
  return `${name} ${settingProblem(def, raw)}. It's ${JSON.stringify(raw)}.`;
}

type Env = Record<string, string | undefined>;

/** Every entry's environment variable that's set but doesn't parse, each naming the variable. */
export function checkSettingsEnv(env: Env): string[] {
  return ALL_SETTINGS.flatMap((key) => {
    const def = settingDef(key);
    const raw = env[def.env];
    if (!raw?.trim()) return [];
    return settingValueProblem(def.env, def, raw) ?? [];
  });
}

/** Env, then the config file, then the stored value, then the default. A value outside the entry's type or bounds is skipped. */
export function resolveSettings(env: Env, stored: Record<string, unknown>, file: Record<string, unknown> = {}): Record<SettingKey, SettingState> {
  const own = (key: SettingKey): { value: boolean | number | string; source: SettingSource } => {
    const def = settingDef(key);
    const fromEnv = env[def.env]?.trim() ? parseSettingValue(def, env[def.env]) : undefined;
    if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
    const fromFile = parseSettingValue(def, file[key]);
    if (fromFile !== undefined) return { value: fromFile, source: "file" };
    const fromSettings = def.configOnly ? undefined : parseSettingValue(def, stored[key]);
    if (fromSettings !== undefined) return { value: fromSettings, source: "settings" };
    return { value: def.default, source: "default" };
  };
  const on = (key: SettingKey): boolean => {
    const dependency = settingDef(key).dependsOn;
    if (dependency !== undefined && !(isSettingKey(dependency) && on(dependency))) return false;
    return settingDef(key).type === "boolean" ? own(key).value === true : true;
  };

  return Object.fromEntries(
    ALL_SETTINGS.map((key) => {
      const def = settingDef(key);
      const dependency = def.dependsOn !== undefined && isSettingKey(def.dependsOn) ? def.dependsOn : null;
      const state: SettingState = {
        key,
        def,
        ...own(key),
        available: dependency === null || on(dependency),
        dependsOn: dependency ? { key: dependency, label: settingDef(dependency).label } : null,
      };
      return [key, state];
    }),
  ) as Record<SettingKey, SettingState>;
}

/** The value code reads: a boolean is false while what it depends on is off. */
export function effectiveValue<K extends SettingKey>(state: SettingState): SettingValue<K> {
  if (state.def.type === "boolean") return (state.available && state.value === true) as SettingValue<K>;
  return state.value as SettingValue<K>;
}
