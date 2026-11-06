/** A provider's send rate and its non-send API rate, counted across every process. */
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import type { ProviderRow } from "@/lib/providers";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("providers:send-rate");

/** Share of the provider's per-second rate the workers claim. */
export const SEND_RATE_HEADROOM = 0.8;

/** Burst allowance, as this much time's worth of sends. With the headroom, no second exceeds 90% of the provider's rate. */
export const SEND_RATE_BURST_MS = 125;

/** How long a reported rate is trusted without a fresh probe. */
export const SEND_RATE_TTL_SECONDS = 60 * 60;

/** SES's limit on every API action except sending, per provider. `SES_API_RATE_PER_SECOND` overrides it for the test suite. */
export const API_RATE = { perSecond: Number(process.env.SES_API_RATE_PER_SECOND) || 1 };

/** Share of that limit callers take, so latency between permit and request can't put two calls in one second. */
export const API_RATE_HEADROOM = 0.8;

const RATE_KEY_PREFIX = "send-rate:limit:";
const BUCKET_KEY_PREFIX = "send-rate:bucket:";
const API_BUCKET_KEY_PREFIX = "api-rate:bucket:";

// Token bucket on Redis's clock. KEYS: rate, bucket. ARGV: wanted, headroom, burst ms, fixed rate. Returns the grant and ms until the next permit.
const ACQUIRE = `
local rate = tonumber(ARGV[4]) or tonumber(redis.call('GET', KEYS[1]))
local want = tonumber(ARGV[1])
if not rate or rate <= 0 then return {want, 0} end
local perMs = rate * tonumber(ARGV[2]) / 1000
local capacity = math.max(1, perMs * tonumber(ARGV[3]))
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', KEYS[2], 'tokens', 'at')
local tokens = tonumber(state[1]) or capacity
local at = tonumber(state[2]) or nowMs
tokens = math.min(capacity, tokens + math.max(0, nowMs - at) * perMs)
local grant = math.min(want, math.floor(tokens))
tokens = tokens - grant
redis.call('HSET', KEYS[2], 'tokens', tostring(tokens), 'at', tostring(nowMs))
redis.call('PEXPIRE', KEYS[2], math.ceil(capacity / perMs) + 1000)
local waitMs = 0
if grant < want then waitMs = math.ceil((1 - tokens) / perMs) end
return {grant, waitMs}
`;

const REFUND = `
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HINCRBYFLOAT', KEYS[1], 'tokens', ARGV[1]) end
return 0
`;

/** The provider a row sends through: its provider identity when known, else its shared provider, else the row. */
export function sendRateSubject(provider: Pick<ProviderRow, "id" | "adapter" | "providerIdentity" | "sharedProviderId">): string {
  if (provider.providerIdentity) return `${provider.adapter}:${provider.providerIdentity}`;
  return provider.sharedProviderId ?? provider.id;
}

/** The provider a row's non-send calls count against, or null until its identity is known. */
export function apiRateSubject(provider: Pick<ProviderRow, "adapter" | "providerIdentity">): string | null {
  return provider.providerIdentity ? `${provider.adapter}:${provider.providerIdentity}` : null;
}

/** Stores the provider's per-second rate for a rate subject. */
export async function setSendRate(subject: string, perSecond: number): Promise<void> {
  const client = redis();
  if (!client) return;
  try {
    await client.set(`${RATE_KEY_PREFIX}${subject}`, String(perSecond), "EX", SEND_RATE_TTL_SECONDS);
  } catch (err) {
    log.warn(`storing the send rate for ${subject} failed: ${safeErrorMessage(err)}`);
  }
}

export interface SendPermits {
  granted: number;
  /** When fewer than wanted were granted, how long until the next one. */
  retryInMs: number;
}

type Acquire = (client: NonNullable<ReturnType<typeof redis>>) => Promise<unknown>;

async function acquire(subject: string, wanted: number, run: Acquire): Promise<SendPermits> {
  if (wanted <= 0) return { granted: 0, retryInMs: 0 };
  const client = redis();
  if (!client) return { granted: wanted, retryInMs: 0 };
  try {
    const [granted, retryInMs] = (await run(client)) as [number, number];
    return { granted: Number(granted), retryInMs: Number(retryInMs) };
  } catch (err) {
    log.warn(`acquiring permits for ${subject} failed: ${safeErrorMessage(err)}`);
    return { granted: wanted, retryInMs: 0 };
  }
}

/** How many of `wanted` sends may start now. Unlimited when no rate is known or Redis is unavailable. */
export async function acquireSendPermits(subject: string, wanted: number): Promise<SendPermits> {
  return acquire(subject, wanted, (client) =>
    client.eval(ACQUIRE, 2, `${RATE_KEY_PREFIX}${subject}`, `${BUCKET_KEY_PREFIX}${subject}`, wanted, SEND_RATE_HEADROOM, SEND_RATE_BURST_MS),
  );
}

/** Whether one non-send API call may start now. Separate from send permits; unlimited without Redis. */
export async function acquireApiPermit(subject: string): Promise<SendPermits> {
  const bucket = `${API_BUCKET_KEY_PREFIX}${subject}`;
  return acquire(subject, 1, (client) => client.eval(ACQUIRE, 2, bucket, bucket, 1, API_RATE_HEADROOM, 0, API_RATE.perSecond));
}

/** Waits for a non-send permit. False when none came within `maxWaitMs`. */
export async function waitForApiPermit(subject: string, maxWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const { granted, retryInMs } = await acquireApiPermit(subject);
    if (granted > 0) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(retryInMs, remaining))));
  }
}

/** Returns permits a round took but didn't use. */
export async function refundSendPermits(subject: string, unused: number): Promise<void> {
  if (unused <= 0) return;
  const client = redis();
  if (!client) return;
  try {
    await client.eval(REFUND, 1, `${BUCKET_KEY_PREFIX}${subject}`, unused);
  } catch (err) {
    log.warn(`refunding send permits for ${subject} failed: ${safeErrorMessage(err)}`);
  }
}
