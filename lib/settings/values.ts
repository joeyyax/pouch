/** Registry settings, resolved per call so every process sees a change on its next read. */
import { ApiError } from "@/lib/api/errors";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import {
  ALL_SETTINGS,
  effectiveValue,
  isFeature,
  parseSettingValue,
  settingDef,
  settingProblem,
  type SettingKey,
  type SettingState,
  type SettingValue,
} from "./registry";
import { resolveCurrentSettings } from "./current";
import { settingsFile } from "./file";
import { setStoredSetting } from "./service";
import { assertCeilingBelowBucketRule, assertInboundCeilingBelowBucketRule } from "@/lib/storage/lifecycle";
import { assertSignInStaysOpen } from "@/lib/auth/sign-in-methods";

export { resolveCurrentSettings };

/** Checks an entry's value against something outside the registry before it's stored. */
const CHECKS: Partial<Record<SettingKey, (value: boolean | number | string) => Promise<void>>> = {
  body_retention_max_days: (value) => assertCeilingBelowBucketRule(value as number),
  inbound_retention_max_days: (value) => assertInboundCeilingBelowBucketRule(value as number),
  sign_in_password: (value) => assertSignInStaysOpen("sign_in_password", value as boolean),
  sign_in_passkey: (value) => assertSignInStaysOpen("sign_in_passkey", value as boolean),
  sign_in_magic_link: (value) => assertSignInStaysOpen("sign_in_magic_link", value as boolean),
};

/** Every setting's state, in registry order. */
export async function readSettings(): Promise<SettingState[]> {
  const states = await resolveCurrentSettings();
  return ALL_SETTINGS.map((key) => states[key]);
}

/** The value code reads. */
export async function readSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  return effectiveValue<K>((await resolveCurrentSettings())[key]);
}

/** Every value code reads, from one read. */
export async function readSettingValues(): Promise<{ [K in SettingKey]: SettingValue<K> }> {
  const states = await resolveCurrentSettings();
  return Object.fromEntries(ALL_SETTINGS.map((key) => [key, effectiveValue(states[key])])) as { [K in SettingKey]: SettingValue<K> };
}

/** Validates and stores an admin's value, and records the change. A value the environment or config file sets can't be changed here. */
export async function setSetting(key: SettingKey, raw: unknown, actor: ActivityActor): Promise<void> {
  const def = settingDef(key);
  const before = (await resolveCurrentSettings())[key];
  if (before.source === "file") {
    throw new ApiError("validation_failed", `${settingsFile().name} sets ${def.label}, so it changes there.`, { field: key });
  }
  if (before.source === "env" || def.configOnly) {
    throw new ApiError("validation_failed", `${def.env} sets ${def.label}, so it changes there.`, { field: key });
  }
  const value = parseSettingValue(def, raw);
  if (value === undefined) throw new ApiError("validation_failed", `${def.label} ${settingProblem(def, raw)}.`, { field: key });
  if (before.source === "settings" && before.value === value) return;
  await CHECKS[key]?.(value);

  await setStoredSetting(key, value);
  if (before.value === value) return;
  await recordActivity({
    organizationId: null,
    action: isFeature(key) ? (value ? "system.feature.turned_on" : "system.feature.turned_off") : "system.setting.changed",
    actor,
    appliesTo: key,
    subjectLabel: def.label,
    metadata: { setting: key, from: before.value, to: value },
  });
}
