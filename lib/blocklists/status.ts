/** Whether blocklist checks run, and why not. The key comes from `SPAMHAUS_DQS_KEY`. */
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { sendPushAlert } from "@/lib/notifications/push/push";
import { DAILY_QUERY_LIMIT, QUERY_CEILING, queriesUsed } from "./budget";
import { validKey, type CheckErrorKind } from "./lists";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("blocklists");

export const KEY_ENV = "SPAMHAUS_DQS_KEY";

const KEY_STATE = "blocklists:key-state";

export function dqsKey(): string | null {
  const key = process.env[KEY_ENV]?.trim();
  return key ? key : null;
}

export interface KeyProblem {
  error: CheckErrorKind;
  code: string | null;
  at: string;
}

export type BlocklistStatus =
  | { state: "off" }
  | { state: "no_redis" }
  | { state: "key_invalid"; detail: string }
  | { state: "paused"; used: number }
  | { state: "on"; used: number; limit: number };

export async function readKeyProblem(): Promise<KeyProblem | null> {
  const raw = await redis()?.get(KEY_STATE);
  return raw ? (JSON.parse(raw) as KeyProblem) : null;
}

/** Records the key as failing. Pushes once when it starts failing. */
export async function markKeyProblem(error: CheckErrorKind, code: string | null, now: Date): Promise<void> {
  const client = redis();
  if (!client) return;
  const problem: KeyProblem = { error, code, at: now.toISOString() };
  const previous = await client.getset(KEY_STATE, JSON.stringify(problem));
  if (previous) return;
  const message = `Spamhaus answered the test query with ${code ?? "no listing"} (${describeKeyProblem(problem)}). Blocklist checks are off until the ${KEY_ENV} key works.`;
  log.error(message);
  await sendPushAlert({ title: "Blocklist key isn't working", message, tags: ["warning"], priority: 4 }).catch((err: unknown) => {
    log.warn(`couldn't push the key warning: ${safeErrorMessage(err)}`);
  });
}

export async function clearKeyProblem(): Promise<void> {
  const client = redis();
  if (!client) return;
  if ((await client.del(KEY_STATE)) > 0) log.info("the Spamhaus key works again");
}

export function describeKeyProblem(problem: Pick<KeyProblem, "error">): string {
  switch (problem.error) {
    case "key_invalid":
      return "the key isn't valid";
    case "refused":
      return "Spamhaus refused the query";
    case "rate_limited":
      return "Spamhaus reports too many queries";
    case "timeout":
      return "the lookup timed out";
    default:
      return "the answer wasn't the test listing";
  }
}

export async function blocklistStatus(now: Date): Promise<BlocklistStatus> {
  const key = dqsKey();
  if (!key) return { state: "off" };
  if (!validKey(key)) return { state: "key_invalid", detail: `${KEY_ENV} isn't a DQS key.` };
  if (!redis()) return { state: "no_redis" };
  const [problem, used] = await Promise.all([readKeyProblem(), queriesUsed(now)]);
  if (problem) return { state: "key_invalid", detail: `Spamhaus: ${describeKeyProblem(problem)}.` };
  if (used >= QUERY_CEILING.sweep) return { state: "paused", used };
  return { state: "on", used, limit: DAILY_QUERY_LIMIT };
}
