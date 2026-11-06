/** How long a delivery keeps retrying before it's exhausted, per docs/api/conventions.md. */
export const DELIVERY_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Delay before attempt N+1, indexed by the attempt just made (1-indexed). Past the list, every 6h. */
const SCHEDULE_MS = [
  30 * 1000, // 30s
  2 * 60 * 1000, // 2m
  5 * 60 * 1000, // 5m
  15 * 60 * 1000, // 15m
  30 * 60 * 1000, // 30m
  60 * 60 * 1000, // 1h
  2 * 60 * 60 * 1000, // 2h
  4 * 60 * 60 * 1000, // 4h
  8 * 60 * 60 * 1000, // 8h
];

const STEADY_STATE_MS = 6 * 60 * 60 * 1000; // 6h

/** The delay before the next attempt, given how many attempts have already been made. */
export function backoffDelayMs(attempts: number): number {
  return SCHEDULE_MS[attempts - 1] ?? STEADY_STATE_MS;
}

export interface NextAttempt {
  nextAttemptAt: Date;
  /** True when the next scheduled attempt would land past expiresAt — the delivery stops here. */
  exhausted: boolean;
}

/** Where the next attempt lands after a failure, and whether it lands past the delivery's expiry. */
export function nextAttempt(attempts: number, now: Date, expiresAt: Date): NextAttempt {
  const nextAttemptAt = new Date(now.getTime() + backoffDelayMs(attempts));
  return { nextAttemptAt, exhausted: nextAttemptAt.getTime() >= expiresAt.getTime() };
}
