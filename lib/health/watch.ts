/**
 * Pushes to ntfy when a registered check changes state: once when it starts failing, once when
 * it recovers, nothing in between. Push is the channel because the mail that would carry an
 * alert is what's down (docs/engineering.md).
 */
import { baseUrl } from "@/lib/api/urls";
import { logger } from "@/lib/logger";
import { sendPushAlert } from "@/lib/notifications/push/push";
import { redis } from "@/lib/redis";
import type { CheckReport } from "./registry";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("health:watch");

export type CheckState = "ok" | "failing";

export interface HealthTransition {
  check: string;
  critical: boolean;
  to: CheckState;
  detail: string | null;
}

/** Where the last seen state of each check lives between passes. */
export interface WatchStore {
  read: () => Promise<Record<string, CheckState>>;
  write: (state: Record<string, CheckState>) => Promise<void>;
}

/**
 * A check seen for the first time announces only if it's failing: a worker booting into an
 * outage is news, one booting into a healthy service isn't.
 */
export function transitionsOf(previous: Record<string, CheckState>, checks: Record<string, CheckReport>): HealthTransition[] {
  const found: HealthTransition[] = [];
  for (const [check, report] of Object.entries(checks)) {
    const to: CheckState = report.ok ? "ok" : "failing";
    const from = previous[check] ?? "ok";
    if (from !== to) found.push({ check, critical: report.critical, to, detail: report.detail });
  }
  return found;
}

export async function pushTransition(transition: HealthTransition): Promise<void> {
  const failing = transition.to === "failing";
  await sendPushAlert({
    title: failing ? `${transition.check} is failing` : `${transition.check} recovered`,
    message: failing ? (transition.detail ?? "The check failed.") : "The check passes again.",
    tags: [failing ? "warning" : "white_check_mark"],
    priority: failing && transition.critical ? 4 : 3,
    click: `${baseUrl()}/admin/settings/system`,
  });
}

/**
 * Compares a report against the stored state, records the new state, then pushes each change.
 * The state lands first, so a push that fails is logged and never repeated.
 */
export async function watchChecks(
  store: WatchStore,
  checks: Record<string, CheckReport>,
  push: (transition: HealthTransition) => Promise<void> = pushTransition,
): Promise<HealthTransition[]> {
  const previous = await store.read();
  const found = transitionsOf(previous, checks);
  await store.write(Object.fromEntries(Object.entries(checks).map(([check, report]) => [check, report.ok ? "ok" : "failing"])));
  for (const transition of found) {
    await push(transition).catch((err: Error) => log.warn(`push for ${transition.check} failed: ${safeErrorMessage(err)}`));
  }
  return found;
}

const STATE_KEY = "health:watch:state";
const memory: { state: Record<string, CheckState> } = { state: {} };

/**
 * Redis holds the state so replicas share one view; the process copy covers Redis being down,
 * which is itself a check that changes state.
 */
export const watchStore: WatchStore = {
  async read() {
    try {
      const stored = (await redis()?.hgetall(STATE_KEY)) as Record<string, CheckState> | undefined;
      if (stored && Object.keys(stored).length > 0) return stored;
    } catch (err) {
      log.warn(`reading the watch state failed: ${safeErrorMessage(err)}`);
    }
    return memory.state;
  },
  async write(state) {
    memory.state = state;
    try {
      const client = redis();
      if (client) await client.multi().del(STATE_KEY).hset(STATE_KEY, state).exec();
    } catch (err) {
      log.warn(`storing the watch state failed: ${safeErrorMessage(err)}`);
    }
  },
};
