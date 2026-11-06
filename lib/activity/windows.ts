/** The activity log's retention windows: setup changes, routine events, and sign-ins with a floor. */

/** Sign-in events are kept at least this long, whatever the routine window says. */
export const SIGN_IN_FLOOR_DAYS = 90;

/** `setup` follows the setup window, `churn` the routine one, `sign_in` the routine one held to the floor. */
export type RetentionClass = "setup" | "churn" | "sign_in";

export interface RetentionWindows {
  setup: number;
  churn: number;
}

export function windowDays(retention: RetentionClass, windows: RetentionWindows): number {
  if (retention === "setup") return windows.setup;
  if (retention === "churn") return windows.churn;
  return Math.max(windows.churn, SIGN_IN_FLOOR_DAYS);
}
