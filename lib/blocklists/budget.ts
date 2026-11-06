/**
 * The free DQS terms allow 100,000 queries a day. Every query takes a slot from one Redis counter
 * per UTC day; link checks stop first so the daily domain sweep keeps room.
 */
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { sendPushAlert } from "@/lib/notifications/push/push";
import { formatNumber } from "@/lib/format/number";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("blocklists:budget");

export const DAILY_QUERY_LIMIT = 100_000;

/** Where each kind of check stops, under the limit. */
export const QUERY_CEILING = { links: 75_000, sweep: 90_000 } as const;
export type QueryPurpose = keyof typeof QUERY_CEILING;

const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;

// Increments only while under the ceiling, so a refused query doesn't count.
const TAKE = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return -1 end
used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return used
`;

export function budgetDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function counterKey(day: string): string {
  return `blocklists:queries:${day}`;
}

/** Takes one query slot. False when the day's ceiling for this purpose is reached or Redis is missing. */
export async function takeQuery(purpose: QueryPurpose, now: Date): Promise<boolean> {
  const client = redis();
  if (!client) return false;
  const day = budgetDay(now);
  const used = Number(await client.eval(TAKE, 1, counterKey(day), QUERY_CEILING[purpose], TWO_DAYS_SECONDS));
  if (used >= 0) return true;
  await warnSpent(purpose, day);
  return false;
}

export async function queriesUsed(now: Date): Promise<number> {
  const client = redis();
  if (!client) return 0;
  return Number((await client.get(counterKey(budgetDay(now)))) ?? 0);
}

/** One push per purpose per day. */
async function warnSpent(purpose: QueryPurpose, day: string): Promise<void> {
  const client = redis();
  if (!client) return;
  const first = await client.set(`blocklists:budget-warned:${purpose}:${day}`, "1", "EX", TWO_DAYS_SECONDS, "NX");
  if (first !== "OK") return;
  const what = purpose === "links" ? "Link-domain checks" : "Sending-domain checks";
  const message = `${what} stopped for ${day} (UTC) at ${formatNumber(QUERY_CEILING[purpose])} Spamhaus queries. The free DQS limit is ${formatNumber(DAILY_QUERY_LIMIT)} a day. Checks resume at 00:00 UTC.`;
  log.error(message);
  await sendPushAlert({ title: "Blocklist query budget reached", message, tags: ["warning"], priority: 4 }).catch((err: unknown) => {
    log.warn(`couldn't push the budget warning: ${safeErrorMessage(err)}`);
  });
}
