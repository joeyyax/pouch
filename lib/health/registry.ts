/**
 * The checks behind `/healthz?detail`. A failing critical check makes the report `error` and
 * answers 503; a failing non-critical one makes it `degraded` and still answers 200.
 *
 * The report is unauthenticated, so `detail` is a fixed category a check chose, never an
 * error message: those name hosts and buckets.
 */

export interface HealthResult {
  ok: boolean;
  /** What's wrong, categorized for an unauthenticated audience. Null when ok. */
  detail: string | null;
  /** Counts a monitor can page on. Never an id or anything that reads as volume. */
  counts?: Record<string, number>;
}

export interface HealthCheck {
  name: string;
  critical: boolean;
  run: () => Promise<HealthResult>;
  /** Skips the check when false, for a dependency that's optional and not configured. */
  enabled?: () => boolean;
}

export type CheckReport = { ok: boolean; critical: boolean; detail: string | null } & Record<string, number | boolean | string | null>;

export interface HealthReport {
  ok: boolean;
  status: "ok" | "degraded" | "error";
  checkedAt: string;
  /** Non-critical checks that failed. */
  degraded: string[];
  checks: Record<string, CheckReport>;
}

export const LATE = "Check didn't answer in time.";
const FAILED = "Check failed.";

const checks = new Map<string, HealthCheck>();

/** Registers a check. The same name replaces it, so a module reloaded in dev doesn't add a second. */
export function registerHealthCheck(check: HealthCheck): void {
  checks.set(check.name, check);
}

/** A late check reports as failed, never as fine. */
async function bounded(check: HealthCheck, timeoutMs: number): Promise<HealthResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      check.run(),
      new Promise<HealthResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, detail: LATE }), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    return { ok: false, detail: FAILED };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs every enabled check at once. Never throws. */
export async function runHealthChecks(timeoutMs: number): Promise<HealthReport> {
  const active = [...checks.values()].filter((check) => check.enabled?.() ?? true);
  const results = await Promise.all(active.map(async (check) => ({ check, result: await bounded(check, timeoutMs) })));

  const failedCritical = results.some(({ check, result }) => check.critical && !result.ok);
  const degraded = results.filter(({ check, result }) => !check.critical && !result.ok).map(({ check }) => check.name);

  return {
    ok: !failedCritical,
    status: failedCritical ? "error" : degraded.length > 0 ? "degraded" : "ok",
    checkedAt: new Date().toISOString(),
    degraded,
    checks: Object.fromEntries(
      results.map(({ check, result }) => [
        check.name,
        { ok: result.ok, critical: check.critical, detail: result.detail, ...result.counts },
      ]),
    ),
  };
}
