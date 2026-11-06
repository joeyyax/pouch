/** The conversion job's state, as it's persisted on the provider row's settings. */
import type { ProviderRow } from "./index";

/** Settings key the conversion job writes its state to. */
export const CONVERSION_JOB_KEY = "conversionJob";

/** Heartbeats older than this mean the process running the conversion died. */
export const CONVERSION_STALE_MS = 2 * 60 * 1000;

export interface ConversionJobState {
  state: "running" | "done" | "failed";
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  /** The last stage that finished. */
  reached: string | null;
  /** The stage that failed. */
  stopped_at: string | null;
  error: string | null;
  missing_permissions?: string[];
}

/** A stored job with the verdict on its heartbeat. */
export type ConversionJob = ConversionJobState & { interrupted: boolean };

export function conversionJobOf(provider: Pick<ProviderRow, "settings">, now = Date.now()): ConversionJob | null {
  const raw = provider.settings[CONVERSION_JOB_KEY];
  if (!raw) return null;
  try {
    const job = JSON.parse(raw) as ConversionJobState;
    const interrupted = job.state === "running" && now - Date.parse(job.heartbeat_at) > CONVERSION_STALE_MS;
    return { ...job, interrupted };
  } catch {
    return null;
  }
}
