/** Session length, read once when the app starts: Better Auth fixes it when the instance is built. */
import { logger } from "@/lib/logger";
import { settingsFile } from "@/lib/settings/file";
import { effectiveValue, resolveSettings } from "@/lib/settings/registry";
import { readSetting } from "@/lib/settings/values";
import { safeErrorMessage } from "@/lib/errors/scrub";

/** On globalThis: Next bundles instrumentation and route handlers apart, each with its own copy of this module. */
const state = ((globalThis as unknown as { __sessionLength?: { days: number | null } }).__sessionLength ??= { days: null });

/** Reads the setting into this process. Called once from `register()`. */
export async function loadSessionLength(): Promise<number> {
  try {
    state.days = await readSetting("session_days");
  } catch (error) {
    logger.child("auth").warn(`reading session length failed, using the default: ${safeErrorMessage(error)}`);
    state.days = null;
  }
  return runningSessionDays();
}

/** What this process runs with. Before `loadSessionLength`, the environment, the config file or the default. */
export function runningSessionDays(): number {
  return state.days ?? effectiveValue<"session_days">(resolveSettings(process.env, {}, settingsFile().values).session_days);
}
