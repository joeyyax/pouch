import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { eq, sql } from "drizzle-orm";
import { db, pingDb } from "@/lib/db";
import { domains, messages, providers } from "@/lib/db/schema";
import { redis } from "@/lib/redis";
import { storage, storageBucket } from "@/lib/storage";
import { logger } from "@/lib/logger";
import type { AdapterHealth, Receipt } from "@/lib/providers/adapters/types";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("health:checks");

export interface CheckResult {
  ok: boolean;
  /** What's wrong, categorized for an unauthenticated audience. Null when ok. */
  detail: string | null;
}

/**
 * A probed provider's cached result lives this long. Three times the worker's probe
 * interval, so one missed pass isn't an outage — same margin as the worker heartbeat.
 */
export const PROVIDER_CHECK_TTL_SECONDS = 900;

/** A tenant is probed in a rotating sample, so its result outlives a full rotation (`worker/health-check.ts`). */
export const TENANT_CHECK_TTL_SECONDS = 24 * 60 * 60;

/** A single send failure is noise a retry usually clears. This many in a row is a pattern. */
export const SEND_FAILURE_THRESHOLD = 3;

const PROVIDER_KEY_PREFIX = "health:provider:";

function providerKey(providerId: string): string {
  return `${PROVIDER_KEY_PREFIX}${providerId}`;
}

export interface StoredProviderRecord {
  adapter: string;
  ok: boolean | null;
  detail: string | null;
  checkedAt: string;
  source: "probe" | "send";
  consecutiveFailures: number;
}

export interface ProviderHealthView {
  providerId: string;
  adapter: string;
  /** Null when nothing has checked this provider yet, or Redis can't be reached. */
  ok: boolean | null;
  detail: string | null;
  checkedAt: Date | null;
  source: "probe" | "send" | null;
  /** Domains bound to this provider. Nothing can fail on a provider with none. */
  boundDomains: number;
}

export async function readProviderRecord(providerId: string): Promise<StoredProviderRecord | null> {
  const client = redis();
  if (!client) return null;
  try {
    const raw = await client.get(providerKey(providerId));
    return raw ? (JSON.parse(raw) as StoredProviderRecord) : null;
  } catch (err) {
    log.warn(`reading the health record for ${providerId} failed: ${safeErrorMessage(err)}`);
    return null;
  }
}

async function writeProviderRecord(
  providerId: string,
  adapter: string,
  outcome: { ok: boolean | null; detail: string | null },
  source: "probe" | "send",
  ttlSeconds: number = PROVIDER_CHECK_TTL_SECONDS,
): Promise<void> {
  const client = redis();
  if (!client) return;

  const previous = await readProviderRecord(providerId);

  // A probe is deliberate and infrequent, so its verdict lands immediately. A send happens
  // constantly and one failed message is often about that message, not the provider — it only
  // flips the verdict after a run of them.
  let consecutiveFailures: number;
  let ok: boolean | null;
  if (outcome.ok === null) {
    // Can't check, not a failure: leave the failure streak alone. Overwrites any prior
    // true/false verdict on purpose — a stale "ok" would be a false green, worse than null.
    consecutiveFailures = previous?.consecutiveFailures ?? 0;
    ok = null;
  } else if (source === "probe") {
    consecutiveFailures = outcome.ok ? 0 : (previous?.consecutiveFailures ?? 0) + 1;
    ok = outcome.ok;
  } else if (outcome.ok) {
    consecutiveFailures = 0;
    ok = true;
  } else {
    consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    // previous?.ok ?? true would turn a stored null into true here — distinguish "no
    // record" (start from true) from "record with a null verdict" (stay null).
    ok = consecutiveFailures < SEND_FAILURE_THRESHOLD ? (previous ? previous.ok : true) : false;
  }

  const record: StoredProviderRecord = {
    adapter,
    ok,
    detail: outcome.detail,
    checkedAt: new Date().toISOString(),
    source,
    consecutiveFailures,
  };
  try {
    await client.set(providerKey(providerId), JSON.stringify(record), "EX", ttlSeconds);
  } catch (err) {
    log.warn(`recording the health check for ${providerId} failed: ${safeErrorMessage(err)}`);
  }
}

/** Records a probe's outcome, including an adapter's honest `ok: null` when it has no way to check itself. A throttled probe leaves the record alone. */
export async function recordProviderProbe(providerId: string, adapter: string, result: AdapterHealth, ttlSeconds?: number): Promise<void> {
  if (result.throttled) return;
  await writeProviderRecord(providerId, adapter, { ok: result.ok, detail: result.detail }, "probe", ttlSeconds);
}

/**
 * A real send's outcome is evidence too: a provider that just delivered is reachable, and a run
 * of failures is a stronger signal than any synthetic probe. A permanent failure (bad recipient,
 * rejected content) is about the message, not the provider, so it isn't evidence either way.
 */
export function sendEvidence(receipt: Receipt): CheckResult | null {
  if (receipt.successful) return { ok: true, detail: null };
  if (receipt.lostSetup) return { ok: false, detail: `The provider no longer has this provider's ${receipt.lostSetup.resource}; rebuilding it.` };
  if (receipt.failure === "backoff") return { ok: false, detail: "Rate limited or paused by the provider." };
  if (receipt.failure === "transient") return { ok: false, detail: "Provider returned a server error." };
  return null;
}

export async function recordProviderSendOutcome(providerId: string, adapter: string, receipt: Receipt, ttlSeconds?: number): Promise<void> {
  const outcome = sendEvidence(receipt);
  if (!outcome) return;
  await writeProviderRecord(providerId, adapter, outcome, "send", ttlSeconds);
}

/** Every provider's cached health, for /healthz?detail and (through lib/health) the settings screen. */
export async function listProviderHealth(): Promise<ProviderHealthView[]> {
  const rows = await db
    .select({
      id: providers.id,
      adapter: providers.adapter,
      boundDomains: sql<number>`count(${domains.id})::int`,
    })
    .from(providers)
    .leftJoin(domains, eq(domains.providerId, providers.id))
    .groupBy(providers.id, providers.adapter);
  const client = redis();

  return Promise.all(
    rows.map(async ({ id, adapter, boundDomains }) => {
      const record = client ? await readProviderRecord(id) : null;
      return {
        providerId: id,
        adapter,
        ok: record?.ok ?? null,
        detail: record ? record.detail : client ? "Not checked yet." : "Redis isn't configured; health can't be tracked.",
        checkedAt: record ? new Date(record.checkedAt) : null,
        source: record?.source ?? null,
        boundDomains,
      };
    }),
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(message)), timeoutMs).unref()),
  ]);
}

/** Postgres, checked live: it's local infrastructure, not a rate-limited third party. */
export async function checkPostgres(timeoutMs = 1500): Promise<CheckResult> {
  const ok = await pingDb(timeoutMs);
  return { ok, detail: ok ? null : "Postgres didn't respond in time." };
}

/** Redis, checked live, same reasoning as Postgres. */
export async function checkRedis(timeoutMs = 1000): Promise<CheckResult> {
  const client = redis();
  if (!client) return { ok: false, detail: "REDIS_URL isn't set." };
  try {
    await withTimeout(client.ping(), timeoutMs, "timeout");
    return { ok: true, detail: null };
  } catch {
    return { ok: false, detail: "Redis didn't respond in time." };
  }
}

/** R2, checked live with HeadBucket — cheap, and it's our own bucket, not someone else's quota. */
export async function checkStorage(timeoutMs = 2000, bucket: () => string = storageBucket): Promise<CheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await storage().send(new HeadBucketCommand({ Bucket: bucket() }), { abortSignal: controller.signal });
    return { ok: true, detail: null };
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0;
    log.warn(`storage check failed (status ${status}): ${safeErrorMessage(err)}`);
    if (status === 403) return { ok: false, detail: "Credentials were rejected." };
    if (status === 404) return { ok: false, detail: "Bucket not found." };
    return { ok: false, detail: "Storage endpoint unreachable." };
  } finally {
    clearTimeout(timer);
  }
}

/** A burst of queued mail is normal; sitting there this long without draining isn't. */
export const QUEUE_STALL_MS = 15 * 60 * 1000;

export interface QueueCheck extends CheckResult {
  depth: number;
  oldestQueuedAt: Date | null;
}

/** Depth and the oldest queued message across every organization — a stalled queue, not a busy one. */
export async function checkQueue(): Promise<QueueCheck> {
  const [row] = await db
    .select({ depth: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${messages.createdAt})` })
    .from(messages)
    .where(eq(messages.status, "queued"));

  const depth = row?.depth ?? 0;
  const oldestQueuedAt = row?.oldest ? new Date(row.oldest) : null;
  const stalled = oldestQueuedAt !== null && Date.now() - oldestQueuedAt.getTime() > QUEUE_STALL_MS;

  return {
    ok: !stalled,
    detail: stalled ? "Queue isn't moving." : null,
    depth,
    oldestQueuedAt,
  };
}
