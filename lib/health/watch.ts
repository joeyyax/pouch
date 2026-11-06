/**
 * Pushes to ntfy when a registered check changes state: once on its second failing pass in a row,
 * once when it recovers, nothing in between. Push is the channel because the mail that would carry
 * an alert is what's down (docs/engineering.md).
 */
import { baseUrl } from "@/lib/api/urls";
import { logger } from "@/lib/logger";
import { sendPushAlert } from "@/lib/notifications/push/push";
import { redis } from "@/lib/redis";
import type { CheckReport } from "./registry";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("health:watch");

/** `suspect`: one failing pass, not announced. */
export type CheckState = "ok" | "suspect" | "failing";

export interface HealthTransition {
  check: string;
  critical: boolean;
  to: "ok" | "failing";
  detail: string | null;
}

/** Where the last seen state of each check lives between passes. */
export interface WatchStore {
  read: () => Promise<Record<string, CheckState>>;
  write: (state: Record<string, CheckState>) => Promise<void>;
}

function nextState(previous: CheckState, ok: boolean): CheckState {
  if (ok) return "ok";
  return previous === "ok" ? "suspect" : "failing";
}

/**
 * The state each check moves to, and what's worth announcing. A check seen for the first time
 * counts as ok, so booting into an outage announces on the second pass and booting healthy never.
 */
function advance(
  previous: Record<string, CheckState>,
  checks: Record<string, CheckReport>,
): { state: Record<string, CheckState>; transitions: HealthTransition[] } {
  const state: Record<string, CheckState> = {};
  const transitions: HealthTransition[] = [];
  for (const [check, report] of Object.entries(checks)) {
    const from = previous[check] ?? "ok";
    const to = nextState(from, report.ok);
    state[check] = to;
    if ((from === "suspect" && to === "failing") || (from === "failing" && to === "ok")) {
      transitions.push({ check, critical: report.critical, to, detail: report.detail });
    }
  }
  return { state, transitions };
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
  const { state, transitions } = advance(await store.read(), checks);
  await store.write(state);
  for (const transition of transitions) {
    await push(transition).catch((err: Error) => log.warn(`push for ${transition.check} failed: ${safeErrorMessage(err)}`));
  }
  return transitions;
}

const STATE_KEY = "health:watch:state";
const SUSPECT_KEY = "health:watch:suspect";
const memory: { state: Record<string, CheckState> } = { state: {} };

/**
 * `STATE_KEY` keeps only `ok` and `failing`, so a release from before `suspect` still reads it
 * correctly mid-deploy. Suspicion lives in its own set.
 */
export function toStored(state: Record<string, CheckState>): { state: Record<string, "ok" | "failing">; suspect: string[] } {
  const stored: Record<string, "ok" | "failing"> = {};
  const suspect: string[] = [];
  for (const [check, value] of Object.entries(state)) {
    stored[check] = value === "failing" ? "failing" : "ok";
    if (value === "suspect") suspect.push(check);
  }
  return { state: stored, suspect };
}

export function fromStored(stored: Record<string, string>, suspect: string[]): Record<string, CheckState> {
  const state: Record<string, CheckState> = {};
  for (const [check, value] of Object.entries(stored)) {
    state[check] = value === "failing" ? "failing" : suspect.includes(check) ? "suspect" : "ok";
  }
  return state;
}

/**
 * Redis holds the state so replicas share one view; the process copy covers Redis being down,
 * which is itself a check that changes state.
 */
export const watchStore: WatchStore = {
  async read() {
    try {
      const client = redis();
      if (client) {
        const [stored, suspect] = await Promise.all([client.hgetall(STATE_KEY), client.smembers(SUSPECT_KEY)]);
        if (Object.keys(stored).length > 0) return fromStored(stored, suspect);
      }
    } catch (err) {
      log.warn(`reading the watch state failed: ${safeErrorMessage(err)}`);
    }
    return memory.state;
  },
  async write(state) {
    memory.state = state;
    try {
      const client = redis();
      if (!client) return;
      const stored = toStored(state);
      const tx = client.multi().del(STATE_KEY).hset(STATE_KEY, stored.state).del(SUSPECT_KEY);
      if (stored.suspect.length > 0) tx.sadd(SUSPECT_KEY, ...stored.suspect);
      await tx.exec();
    } catch (err) {
      log.warn(`storing the watch state failed: ${safeErrorMessage(err)}`);
    }
  },
};
