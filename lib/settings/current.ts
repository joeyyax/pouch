/** The one resolver every registry read goes through. */
import { resolveSettings, type SettingKey, type SettingState } from "./registry";
import { settingsFile } from "./file";
import { readStoredSettings } from "./service";

/** Every entry's state, from the environment, then the config file, then `service_settings`, then the default. */
export async function resolveCurrentSettings(): Promise<Record<SettingKey, SettingState>> {
  return resolveSettings(process.env, await readStoredSettings(), settingsFile().values);
}
