/** The optional features: the boolean entries in the settings registry. */
import { ApiError } from "@/lib/api/errors";
import { settingsFile } from "@/lib/settings/file";
import { ALL_SETTINGS, effectiveValue, isFeature, settingLocation, type Feature, type SettingState } from "@/lib/settings/registry";
import { readSetting, resolveCurrentSettings } from "@/lib/settings/values";

export { featureForPath, type Feature } from "./registry";

/** Which features are on, by key. */
export async function enabledFeatures(): Promise<Record<Feature, boolean>> {
  const states = await resolveCurrentSettings();
  return Object.fromEntries(ALL_SETTINGS.filter(isFeature).map((key) => [key, effectiveValue<Feature>(states[key])])) as Record<Feature, boolean>;
}

export async function isFeatureEnabled(feature: Feature): Promise<boolean> {
  return readSetting(feature);
}

/** Where a switch that's off was turned off. */
function turnedOffBy(state: SettingState): string {
  if (state.source === "env") return `by ${state.def.env}`;
  if (state.source === "file") return `in ${settingsFile().name}`;
  return `in ${settingLocation(state.def.section)}`;
}

/** Throws `feature_disabled` naming the feature, and where it or what it needs was turned off. */
export async function assertFeatureEnabled(feature: Feature): Promise<void> {
  const states = await resolveCurrentSettings();
  if (effectiveValue<Feature>(states[feature])) return;
  let off: SettingState = states[feature];
  while (off.value === true && off.dependsOn) off = states[off.dependsOn.key];
  const message =
    off.key === feature
      ? `Feature "${feature}" is turned off ${turnedOffBy(off)}.`
      : `Feature "${feature}" is turned off because "${off.key}" is, ${turnedOffBy(off)}.`;
  throw new ApiError("feature_disabled", message, { detail: { feature } });
}
