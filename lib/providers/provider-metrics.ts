/** What a provider reports about its own providers, cached in Redis for the system view and standing. */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { providers } from "@/lib/db/schema";
import { STALL_WINDOW_DAYS, type StallLines, type StallMetric } from "@/lib/domains/guard";
import { readStallLines } from "@/lib/domains/stall";
import { logger } from "@/lib/logger";
import { formatRate } from "@/lib/metrics/rates";
import { sendPushAlert } from "@/lib/notifications/push/push";
import type { AccountQuota, AccountRates, MetricRead, TenantVolume } from "@/lib/providers/adapters/types";
import { redis } from "@/lib/redis";
import { AT_RISK_SHARE, RATE_DIGITS } from "@/lib/reputation/standing";
import { adapterFor, type ProviderRow } from "./index";
import { QUOTA_WARN_SHARE, quotaShare } from "./quota";
import { formatNumber } from "@/lib/format/number";
import { safeErrorMessage } from "@/lib/errors/scrub";

export { QUOTA_WARN_SHARE, quotaShare };

const log = logger.child("providers:provider-metrics");

/** A quota read lives three health passes. */
export const QUOTA_TTL_SECONDS = 15 * 60;

/** How often the provider's reputation rates are read again. */
export const RATES_REFRESH_SECONDS = 15 * 60;

/** A reputation read is shown this long without a fresh one. */
export const RATES_TTL_SECONDS = 2 * 60 * 60;

/** A refused permission is asked again after this long. */
export const DENIED_RECHECK_SECONDS = 60 * 60;

/** One tenant findings sweep per shared provider per this long. */
export const FINDINGS_SWEEP_SECONDS = 60 * 60;

/** Pages of findings one sweep reads, each a paced call. */
export const FINDINGS_PAGES_PER_SWEEP = 20;

/** A tenant's own counts are read again after this long. */
export const TENANT_VOLUME_TTL_SECONDS = 60 * 60;

/** The window a tenant's counts cover, matching the stall guard's. */
export const TENANT_VOLUME_DAYS = STALL_WINDOW_DAYS;

/** A crossing stays alerted this long unless it clears first. */
export const CROSSING_TTL_SECONDS = 7 * 24 * 60 * 60;

const QUOTA_PREFIX = "provider-metrics:quota:";
const RATES_PREFIX = "provider-metrics:rates:";
const TENANT_VOLUME_PREFIX = "provider-metrics:tenant-volume:";
const SWEEP_PREFIX = "provider-metrics:findings-sweep:";
const CROSSING_PREFIX = "provider-metrics:crossing:";

export interface QuotaReading extends AccountQuota {
  checkedAt: Date;
}

export type RatesReading = { checkedAt: Date } & (
  | { state: "ok"; bounceRate: number | null; complaintRate: number | null; at: Date | null }
  | { state: "denied"; permission: string }
  | { state: "failed" }
);

const inProcess = new Map<string, { value: string; until: number }>();

async function put(key: string, value: string, ttlSeconds: number, onlyIfAbsent = false): Promise<boolean> {
  const client = redis();
  if (client) {
    try {
      const args = ["EX", ttlSeconds] as const;
      return (onlyIfAbsent ? await client.set(key, value, ...args, "NX") : await client.set(key, value, ...args)) === "OK";
    } catch (err) {
      log.warn(`writing ${key} failed, using this process's memory: ${safeErrorMessage(err)}`);
    }
  }
  const now = Date.now();
  const held = inProcess.get(key);
  if (onlyIfAbsent && held && held.until > now) return false;
  inProcess.set(key, { value, until: now + ttlSeconds * 1000 });
  return true;
}

async function getMany(keys: string[]): Promise<(string | null)[]> {
  if (keys.length === 0) return [];
  const client = redis();
  if (client) {
    try {
      return await client.mget(...keys);
    } catch (err) {
      log.warn(`reading provider metrics failed: ${safeErrorMessage(err)}`);
    }
  }
  const now = Date.now();
  return keys.map((key) => {
    const held = inProcess.get(key);
    return held && held.until > now ? held.value : null;
  });
}

async function drop(key: string): Promise<void> {
  inProcess.delete(key);
  const client = redis();
  if (!client) return;
  try {
    await client.del(key);
  } catch (err) {
    log.warn(`clearing ${key} failed: ${safeErrorMessage(err)}`);
  }
}

function parse<T>(raw: string | null, revive: (value: Record<string, unknown>) => T): T | null {
  if (!raw) return null;
  try {
    return revive(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return null;
  }
}

const date = (value: unknown) => (typeof value === "string" ? new Date(value) : null);

export async function writeQuota(providerIds: string[], quota: AccountQuota, now: Date): Promise<void> {
  const value = JSON.stringify({ ...quota, checkedAt: now.toISOString() });
  await Promise.all(providerIds.map((id) => put(`${QUOTA_PREFIX}${id}`, value, QUOTA_TTL_SECONDS)));
}

export async function readQuotas(providerIds: string[]): Promise<Map<string, QuotaReading>> {
  const raw = await getMany(providerIds.map((id) => `${QUOTA_PREFIX}${id}`));
  const readings = new Map<string, QuotaReading>();
  providerIds.forEach((id, index) => {
    const reading = parse(raw[index] ?? null, (value) => ({ ...(value as unknown as AccountQuota), checkedAt: date(value.checkedAt) ?? new Date(0) }));
    if (reading) readings.set(id, reading);
  });
  return readings;
}

export async function writeRates(providerIds: string[], read: MetricRead<AccountRates>, now: Date): Promise<void> {
  const body =
    read.state === "ok"
      ? { state: "ok", bounceRate: read.value.bounceRate, complaintRate: read.value.complaintRate, at: read.value.at?.toISOString() ?? null }
      : read;
  const value = JSON.stringify({ ...body, checkedAt: now.toISOString() });
  await Promise.all(providerIds.map((id) => put(`${RATES_PREFIX}${id}`, value, RATES_TTL_SECONDS)));
}

export async function readRates(providerIds: string[]): Promise<Map<string, RatesReading>> {
  const raw = await getMany(providerIds.map((id) => `${RATES_PREFIX}${id}`));
  const readings = new Map<string, RatesReading>();
  providerIds.forEach((id, index) => {
    const reading = parse(raw[index] ?? null, (value) => ({ ...value, at: date(value.at), checkedAt: date(value.checkedAt) ?? new Date(0) }) as RatesReading);
    if (reading) readings.set(id, reading);
  });
  return readings;
}

/** Whether the rates are due for another read. A refusal waits longer. */
export function ratesDue(reading: RatesReading | undefined, now: Date): boolean {
  if (!reading) return true;
  const waitSeconds = reading.state === "denied" ? DENIED_RECHECK_SECONDS : RATES_REFRESH_SECONDS;
  return now.getTime() - reading.checkedAt.getTime() >= waitSeconds * 1000;
}

/** One replica sweeps a shared provider's findings per window. */
export function claimFindingsSweep(sharedProviderId: string): Promise<boolean> {
  return put(`${SWEEP_PREFIX}${sharedProviderId}`, "1", FINDINGS_SWEEP_SECONDS, true);
}

/** True once per crossing: when `over` first holds. Clears when it stops holding. */
async function crossed(key: string, over: boolean): Promise<boolean> {
  if (!over) {
    await drop(`${CROSSING_PREFIX}${key}`);
    return false;
  }
  return put(`${CROSSING_PREFIX}${key}`, "1", CROSSING_TTL_SECONDS, true);
}

export interface AlertSubject {
  key: string;
  name: string;
}

export async function checkQuotaAlert(subject: AlertSubject, quota: AccountQuota): Promise<boolean> {
  const share = quotaShare(quota);
  if (share === null) return false;
  if (!(await crossed(`quota:${subject.key}`, share >= QUOTA_WARN_SHARE))) return false;
  await sendPushAlert({
    title: `Send quota at ${Math.floor(share * 100)}%: ${subject.name}`,
    message: `${formatNumber(quota.sentLast24Hours ?? 0)} of ${formatNumber(quota.max24HourSend ?? 0)} sends used in the last 24 hours. Sends past the quota are refused.`,
    tags: ["warning", "email"],
    priority: 4,
  }).catch((err: Error) => log.warn(`couldn't send the quota alert for ${subject.name}: ${safeErrorMessage(err)}`));
  return true;
}

export function atRiskLine(metric: StallMetric, lines: StallLines): number {
  return lines[metric].stall * AT_RISK_SHARE;
}

/** Pushes once when AWS's own rate crosses Pouch's at-risk line. */
export async function checkRatesAlert(subject: AlertSubject, rates: AccountRates): Promise<number> {
  let sent = 0;
  const lines = await readStallLines();
  for (const metric of ["complaint", "bounce"] as const) {
    const value = metric === "bounce" ? rates.bounceRate : rates.complaintRate;
    if (value === null) continue;
    if (!(await crossed(`rates:${metric}:${subject.key}`, value >= atRiskLine(metric, lines)))) continue;
    const digits = RATE_DIGITS[metric];
    await sendPushAlert({
      title: `AWS ${metric} rate at ${formatRate(value, digits)}: ${subject.name}`,
      message: `AWS reports a ${formatRate(value, digits)} ${metric} rate for the provider. It reviews at ${formatRate(lines[metric].providerReview, digits)} and pauses at ${formatRate(lines[metric].providerPause, digits)}.`,
      tags: ["warning", "email"],
      priority: 4,
    }).catch((err: Error) => log.warn(`couldn't send the rate alert for ${subject.name}: ${safeErrorMessage(err)}`));
    sent += 1;
  }
  return sent;
}

/** A tenant's own counts as AWS reports them, or null when there's nothing to show. */
export async function readTenantVolume(tenant: ProviderRow): Promise<TenantVolume | null> {
  const tenantArn = tenant.settings.tenantArn;
  if (!tenant.sharedProviderId || !tenantArn) return null;
  const key = `${TENANT_VOLUME_PREFIX}${tenant.id}`;
  const [cached] = await getMany([key]);
  let read = parse(cached ?? null, (value) => value as unknown as MetricRead<TenantVolume>);
  if (!read) {
    const [shared] = await db.select().from(providers).where(eq(providers.id, tenant.sharedProviderId)).limit(1);
    if (!shared) return null;
    const [sharedRates] = [...(await readRates([shared.id])).values()];
    if (sharedRates?.state === "denied") return null;
    let volume;
    try {
      volume = adapterFor(shared).tenants?.volume;
    } catch (err) {
      log.warn(`building the shared provider for ${tenant.id} failed: ${safeErrorMessage(err)}`);
      return null;
    }
    if (!volume) return null;
    read = await volume(tenantArn, TENANT_VOLUME_DAYS);
    await put(key, JSON.stringify(read), read.state === "denied" ? DENIED_RECHECK_SECONDS : TENANT_VOLUME_TTL_SECONDS);
  }
  return read.state === "ok" ? read.value : null;
}

/** Test hook: forgets everything cached in this process. */
export function resetProviderMetricsMemory(): void {
  inProcess.clear();
}
