/** The three digest cadences and the calendar windows each one covers, in UTC throughout. */
export const DIGEST_CADENCES = ["daily", "weekly", "monthly"] as const;
export type DigestCadence = (typeof DIGEST_CADENCES)[number];

export interface DigestWindow {
  cadence: DigestCadence;
  /** Identifies the window itself — the idempotency key's grain. Stable for the whole window. */
  windowKey: string;
  since: Date;
  until: Date;
  previousSince: Date;
  previousUntil: Date;
}

const DAY_MS = 86_400_000;

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** The Monday-starting week `date` falls in, at UTC midnight. */
function startOfUtcWeek(date: Date): Date {
  const day = startOfUtcDay(date);
  const weekday = day.getUTCDay(); // 0 = Sunday
  const sinceMonday = (weekday + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY_MS);
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/**
 * The window that just closed for one cadence, as of `now`. "Daily" always means the full
 * calendar day before today, never a partial one — the loop only calls this once it's already
 * past the boundary (see `dueCadences`), so the window is always complete.
 */
export function currentWindow(cadence: DigestCadence, now: Date): DigestWindow {
  if (cadence === "daily") {
    const until = startOfUtcDay(now);
    const since = new Date(until.getTime() - DAY_MS);
    const previousUntil = since;
    const previousSince = new Date(previousUntil.getTime() - DAY_MS);
    return { cadence, windowKey: isoDate(since), since, until, previousSince, previousUntil };
  }

  if (cadence === "weekly") {
    const until = startOfUtcWeek(now);
    const since = new Date(until.getTime() - 7 * DAY_MS);
    const previousUntil = since;
    const previousSince = new Date(previousUntil.getTime() - 7 * DAY_MS);
    return { cadence, windowKey: isoDate(since), since, until, previousSince, previousUntil };
  }

  const until = startOfUtcMonth(now);
  const since = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth() - 1, 1));
  const previousUntil = since;
  const previousSince = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth() - 1, 1));
  return { cadence, windowKey: isoDate(since), since, until, previousSince, previousUntil };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Which cadences are due as of `now`, sending at `hour` UTC (`digest_hour`). Gated on the hour so
 * the loop's hourly tick only does the (cheap, but not free) work of computing and sending once a day,
 * once a week, once a month — the idempotency key on the message itself is the real guard
 * against a double send, this just keeps every other tick from touching the database at all.
 */
export function dueCadences(now: Date, hour: number): DigestCadence[] {
  if (now.getUTCHours() !== hour) return [];

  const due: DigestCadence[] = ["daily"];
  if (now.getUTCDay() === 1) due.push("weekly"); // Monday
  if (now.getUTCDate() === 1) due.push("monthly");
  return due;
}
