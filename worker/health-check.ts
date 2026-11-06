import { and, asc, eq, exists, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, providers } from "@/lib/db/schema";
import { adapterFor, type ProviderRow } from "@/lib/providers";
import { TENANT_CHECK_TTL_SECONDS, recordProviderProbe } from "@/lib/health/checks";
import { sendRateSubject, setSendRate } from "@/lib/providers/send-rate";
import {
  FINDINGS_PAGES_PER_SWEEP,
  checkQuotaAlert,
  checkRatesAlert,
  claimFindingsSweep,
  ratesDue,
  readRates,
  writeQuota,
  writeRates,
} from "@/lib/providers/provider-metrics";
import { reconcileTenantFindings } from "@/lib/providers/tenant-status";
import { redis } from "@/lib/redis";
import type { Adapter } from "@/lib/providers/adapters/types";
import { logger } from "@/lib/logger";
import { sendProviderBackingOffAlert } from "@/lib/mail/alerts/provider-backing-off";
import { readSetting } from "@/lib/settings/values";
import { eachBounded } from "@/lib/async";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker:health-check");

/** Providers probed at once. Rows on the same provider never run in parallel. */
export const PROBE_CONCURRENCY = 4;

/** Gap between probes of one provider, on top of the SES pacer. */
export const PROBE_SPACING_MS = 2_000;

/** Tenants of one shared provider probed per pass. EventBridge reports status changes; this is the backstop. */
export const TENANT_PROBES_PER_PASS = 60;

const TENANT_CURSOR_PREFIX = "health:tenant-cursor:";
const TENANT_SWEEP_PREFIX = "health:tenant-sweep:";

export interface ProviderHealthLoopOptions {
  /** Which worker this loop belongs to. The heartbeat is per worker, so replicas must differ. */
  workerId?: string;
  /** Minutes, not seconds — a real provider call runs on every pass. */
  intervalMs: number;
  probeSpacingMs?: number;
  tenantProbesPerPass?: number;
}


/**
 * Probes every provider's credentials and reachability on a slow interval. The worker is
 * the one place this belongs: the app is stateless and multi-instance, and a per-instance timer
 * would multiply the calls against SES.
 */
export class ProviderHealthLoop extends IntervalLoop<number> {
  protected readonly name = "provider-health";
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;

  constructor(private readonly options: ProviderHealthLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  /** Where each shared provider's tenant rotation left off, when Redis isn't there to hold it. */
  private readonly cursors = new Map<string, string>();

  protected async run(): Promise<number> {
    const rows: ProviderRow[] = await db.select().from(providers).where(isNull(providers.sharedProviderId));
    const groups = new Map<string, ProviderRow[]>();
    for (const provider of rows) {
      if (provider.shared) {
        if (!(await this.claimTenantSweep(provider.id))) continue;
        groups.set(`shared:${provider.id}`, [provider, ...(await this.tenantSample(provider.id))]);
        continue;
      }
      // Two rows with the same provider identity are one provider at the provider.
      const key = provider.providerIdentity ? `${provider.adapter}:${provider.providerIdentity}` : provider.id;
      groups.set(key, [...(groups.get(key) ?? []), provider]);
    }

    let checked = 0;
    await eachBounded([...groups.values()], PROBE_CONCURRENCY, async (group) => {
      for (const [index, provider] of group.entries()) {
        if (this.stopped) return;
        if (index > 0) await this.pause();
        const client = await this.probe(provider);
        if (index === 0 && client) {
          await this.readProviderMetrics(group, client).catch((err: Error) => log.warn(`reading metrics for ${provider.id} threw: ${safeErrorMessage(err)}`));
        }
        checked += 1;
      }
    });
    if (!this.stopped) await this.checkBackingOff();
    return checked;
  }

  private async pause(): Promise<void> {
    const spacingMs = this.options.probeSpacingMs ?? PROBE_SPACING_MS;
    if (spacingMs > 0) await new Promise((resolve) => setTimeout(resolve, spacingMs));
  }

  private async probe(provider: ProviderRow): Promise<Adapter | null> {
    const ttl = provider.sharedProviderId ? TENANT_CHECK_TTL_SECONDS : undefined;
    let client: Adapter | null = null;
    try {
      client = adapterFor(provider);
      const result = await client.healthCheck();
      await recordProviderProbe(provider.id, provider.adapter, result, ttl);
    } catch (err) {
      await recordProviderProbe(provider.id, provider.adapter, { ok: false, detail: "The health check threw." }, ttl);
      log.warn(`checking provider ${provider.id} threw: ${safeErrorMessage(err)}`);
    }
    if (!client) return null;
    await this.refreshIdentity(provider, client);
    return client;
  }

  /** Quota, reputation rates and tenant findings, read once for every row on one provider. */
  private async readProviderMetrics(group: ProviderRow[], client: Adapter): Promise<void> {
    const [provider] = group;
    if (!provider || provider.sharedProviderId) return;
    const rows = group.filter((row) => !row.sharedProviderId).map((row) => row.id);
    const subject = { key: provider.providerIdentity ? `${provider.adapter}:${provider.providerIdentity}` : provider.id, name: provider.name };
    const now = await dbNow();

    if (client.quota && !this.stopped) {
      await this.pause();
      const quota = await client.quota();
      if (quota) {
        await writeQuota(rows, quota, now);
        if (quota.maxSendRate) await setSendRate(sendRateSubject(provider), quota.maxSendRate);
        await checkQuotaAlert(subject, quota);
      }
    }

    if (client.reputationRates && !this.stopped && ratesDue((await readRates([provider.id])).get(provider.id), now)) {
      const rates = await client.reputationRates();
      await writeRates(rows, rates, now);
      if (rates.state === "ok") await checkRatesAlert(subject, rates.value);
    }

    if (provider.shared && client.tenants?.findings && !this.stopped && (await claimFindingsSweep(provider.id))) {
      await this.pause();
      await reconcileTenantFindings(provider, client, FINDINGS_PAGES_PER_SWEEP, () => this.pause()).catch((err: Error) =>
        log.warn(`reconciling findings on ${provider.id} threw: ${safeErrorMessage(err)}`),
      );
    }
  }

  /** One replica sweeps a shared provider's tenants per interval, so replicas don't multiply the calls. */
  private async claimTenantSweep(sharedProviderId: string): Promise<boolean> {
    const client = redis();
    if (!client) return true;
    try {
      const ttlMs = Math.max(1, Math.floor(this.intervalMs * 0.9));
      return (await client.set(`${TENANT_SWEEP_PREFIX}${sharedProviderId}`, this.workerId ?? "worker", "PX", ttlMs, "NX")) === "OK";
    } catch (err) {
      log.warn(`claiming the tenant sweep for ${sharedProviderId} failed: ${safeErrorMessage(err)}`);
      return true;
    }
  }

  /** The next tenants in id order after where the last pass stopped, wrapping at the end. */
  private async tenantSample(sharedProviderId: string): Promise<ProviderRow[]> {
    const size = this.options.tenantProbesPerPass ?? TENANT_PROBES_PER_PASS;
    const cursor = await this.readCursor(sharedProviderId);
    // A tenant with no ARN and no domains hasn't been created at the provider yet.
    const tenantsOf = and(
      eq(providers.sharedProviderId, sharedProviderId),
      or(
        sql`${providers.settings}->>'tenantArn' <> ''`,
        exists(
          db
            .select({ id: domains.id })
            .from(domains)
            .where(or(eq(domains.providerId, providers.id), eq(domains.pendingProviderId, providers.id))),
        ),
      ),
    );
    const sample = await db
      .select()
      .from(providers)
      .where(cursor ? and(tenantsOf, gt(providers.id, cursor)) : tenantsOf)
      .orderBy(asc(providers.id))
      .limit(size);
    if (cursor && sample.length < size) {
      const wrapped = await db
        .select()
        .from(providers)
        .where(and(tenantsOf, lte(providers.id, cursor)))
        .orderBy(asc(providers.id))
        .limit(size - sample.length);
      sample.push(...wrapped);
    }
    const last = sample.at(-1);
    if (last) await this.writeCursor(sharedProviderId, last.id);
    return sample;
  }

  private async readCursor(sharedProviderId: string): Promise<string | undefined> {
    const client = redis();
    if (client) {
      try {
        return (await client.get(`${TENANT_CURSOR_PREFIX}${sharedProviderId}`)) ?? undefined;
      } catch (err) {
        log.warn(`reading the tenant cursor for ${sharedProviderId} failed: ${safeErrorMessage(err)}`);
      }
    }
    return this.cursors.get(sharedProviderId);
  }

  private async writeCursor(sharedProviderId: string, id: string): Promise<void> {
    this.cursors.set(sharedProviderId, id);
    const client = redis();
    if (!client) return;
    try {
      await client.set(`${TENANT_CURSOR_PREFIX}${sharedProviderId}`, id, "EX", TENANT_CHECK_TTL_SECONDS);
    } catch (err) {
      log.warn(`storing the tenant cursor for ${sharedProviderId} failed: ${safeErrorMessage(err)}`);
    }
  }

  /**
   * Asks the provider for its own identifier for the provider behind these credentials, and
   * stores it once one comes back. This is how every existing row backfills, and how an adapter
   * that can't answer (Mailpace has no such concept) or a call that fails this tick stays
   * exactly as informative as it already was — a known identity is never overwritten with an
   * unknown one, and a blank identity is never invented.
   */
  private async refreshIdentity(provider: ProviderRow, client: Adapter): Promise<void> {
    if (!client.identity) return;
    // A tenant shares its provider's identity; one answer is enough.
    if (provider.sharedProviderId && provider.providerIdentity) return;
    try {
      const identity = await client.identity();
      if (identity && identity !== provider.providerIdentity) {
        // A shared provider's tenants share its identity.
        const rows = provider.shared ? or(eq(providers.id, provider.id), eq(providers.sharedProviderId, provider.id)) : eq(providers.id, provider.id);
        await db.update(providers).set({ providerIdentity: identity, updatedAt: new Date() }).where(rows);
      }
    } catch (err) {
      log.warn(`fetching the provider identity for ${provider.id} threw: ${safeErrorMessage(err)}`);
    }
  }

  /**
   * Alerts on every provider whose current backoff run has outlasted the window — not a probe,
   * just a read of what worker/send.ts already wrote. Rides this loop instead of growing its
   * own timer, since it's already the one place that walks every provider on a slow
   * interval.
   */
  private async checkBackingOff(): Promise<void> {
    const windowMs = (await readSetting("provider_backoff_alert_minutes")) * 60_000;
    const now = await dbNow();
    const backingOff = await db.select().from(providers).where(isNotNull(providers.backingOffSince));
    for (const provider of backingOff) {
      if (this.stopped) break;
      if (!provider.backingOffSince) continue;
      if (now.getTime() - provider.backingOffSince.getTime() < windowMs) continue;

      // Best-effort: a notification failing here must never affect the provider's own state.
      await sendProviderBackingOffAlert(provider, provider.backingOffSince, windowMs).catch((err) => {
        const reason = safeErrorMessage(err);
        log.warn(`couldn't send the backing-off alert for provider ${provider.id}: ${reason}`);
      });
    }
  }
}
