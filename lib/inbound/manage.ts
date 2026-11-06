import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, providers } from "@/lib/db/schema";
import { adapterFor } from "@/lib/providers";
import { ApiError } from "@/lib/api/errors";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { InboundUnavailableError, type Adapter, type ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { closeInboundRoute, inboundHost } from "./records";
import { deleteDomainEndpoint, readDomainEndpoint, setDisabled, upsertDomainEndpoint } from "@/lib/webhooks/endpoints";
import { inboundWebhookUrl } from "@/lib/api/urls";
import type { UpdateInboundRequest } from "@/lib/schemas/inbound";
import { readSetting } from "@/lib/settings/values";

const log = logger.child("inbound:manage");

export interface InboundCaller {
  organizationId: string;
  actor: ActivityActor;
}

type DomainRow = typeof domains.$inferSelect;

function recordKey(record: ProposedDnsRecord): string {
  return `${record.type}:${record.name}:${record.value}`;
}

/** Merges the provider's inbound records into a domain's DNS record list, without duplicating one already there. */
function mergeDnsRecords(existing: ProposedDnsRecord[], additions: ProposedDnsRecord[]): ProposedDnsRecord[] {
  const seen = new Set(existing.map(recordKey));
  const merged = [...existing];
  for (const record of additions) {
    if (seen.has(recordKey(record))) continue;
    seen.add(recordKey(record));
    merged.push(record);
  }
  return merged;
}

/** Drops every record on `host`, which only inbound proposes. */
function withoutHost(records: ProposedDnsRecord[], host: string): ProposedDnsRecord[] {
  return records.filter((record) => record.name !== host);
}

/** Throws when `host` already carries one of the domain's sending records, such as SES's MAIL FROM MX. */
function assertHostFree(domain: DomainRow, previousHost: string, host: string): void {
  const sending = withoutHost([...domain.dnsRecords, ...domain.pendingDnsRecords], previousHost);
  if (!sending.some((record) => record.name.toLowerCase().replace(/\.$/, "") === host)) return;
  throw new ApiError("validation_failed", `${host} already holds this domain's sending records. Pick another subdomain.`, { field: "subdomain" });
}

async function loadDomain(organizationId: string, domainId: string): Promise<{ domain: DomainRow; providerAdapter: string; client: Adapter }> {
  const [row] = await db
    .select({ domain: domains, provider: providers })
    .from(domains)
    .innerJoin(providers, eq(providers.id, domains.providerId))
    .where(and(eq(domains.organizationId, organizationId), eq(domains.id, domainId)))
    .limit(1);
  if (!row) throw new ApiError("not_found", `No domain with id ${domainId}.`);
  return { domain: row.domain, providerAdapter: row.provider.adapter, client: adapterFor(row.provider) };
}


export interface InboundStatus {
  domainId: string;
  enabled: boolean;
  retentionDays: number;
  subdomain: string;
  /** The host mail is addressed to, `<subdomain>.<domain>`. */
  host: string;
  /** Where Pouch delivers inbound.received. Null until a webhook URL is registered. */
  webhookUrl: string | null;
  /** Where this domain's provider should be told to POST inbound mail — paste this into
   * the provider's console, the same manual step outbound event webhooks already need for a
   * adapter with capabilities.webhooksViaApi false. Null when the provider is routed through its API. */
  receiverUrl: string | null;
  dnsRecords: ProposedDnsRecord[];
}

function statusOf(domain: DomainRow, providerAdapter: string, client: Adapter, webhookUrl: string | null): InboundStatus {
  return {
    domainId: domain.id,
    enabled: domain.inboundEnabled,
    retentionDays: domain.inboundRetentionDays,
    subdomain: domain.inboundSubdomain,
    host: inboundHost(domain.name, domain.inboundSubdomain),
    webhookUrl,
    receiverUrl: client.inbound?.open ? null : inboundWebhookUrl(providerAdapter, domain.id),
    dnsRecords: domain.dnsRecords,
  };
}

export async function readInboundStatus(caller: InboundCaller, domainId: string): Promise<InboundStatus> {
  const { domain, providerAdapter, client } = await loadDomain(caller.organizationId, domainId);
  const endpoint = await readDomainEndpoint(caller.organizationId, domainId);
  return statusOf(domain, providerAdapter, client, endpoint?.url ?? null);
}

export interface UpdateInboundResult {
  status: InboundStatus;
  /** Present only the moment a webhook URL is (re)registered — shown once, like any endpoint secret. */
  webhookSecret: string | null;
}

/**
 * Enables, disables or reconfigures inbound for a domain. The one seam lib/domains/* and
 * app/(app)/domains/* need: everything past "does this adapter receive mail and what does its
 * provider look like" is decided here, not there. See docs/decisions.md and the #6 PR body for
 * why this lives in lib/inbound rather than lib/domains.
 */
export async function updateInboundSettings(
  caller: InboundCaller,
  domainId: string,
  input: UpdateInboundRequest,
): Promise<UpdateInboundResult> {
  if (input.retention_days !== undefined) {
    const ceiling = await readSetting("inbound_retention_max_days");
    if (input.retention_days > ceiling) {
      throw new ApiError("validation_failed", `Field "retention_days" can't be above ${ceiling}, this install's ceiling.`, {
        field: "retention_days",
        detail: { max: ceiling },
      });
    }
  }
  const { domain, providerAdapter, client } = await loadDomain(caller.organizationId, domainId);
  const subdomain = input.subdomain ?? domain.inboundSubdomain;
  const previousHost = inboundHost(domain.name, domain.inboundSubdomain);
  const host = inboundHost(domain.name, subdomain);
  const kept = host === previousHost ? domain.dnsRecords : withoutHost(domain.dnsRecords, previousHost);

  if (input.enabled) {
    assertHostFree(domain, previousHost, host);
    if (input.webhook_url === null) {
      throw new ApiError("validation_failed", "Enabling inbound requires a webhook URL.", { field: "webhook_url" });
    }
    if (!client.inbound) {
      throw new ApiError("capability_unavailable", `${providerAdapter} doesn't receive mail.`);
    }

    const existingEndpoint = await readDomainEndpoint(caller.organizationId, domainId);
    if (!input.webhook_url && !existingEndpoint) {
      throw new ApiError("validation_failed", "Enabling inbound requires a webhook URL.", { field: "webhook_url" });
    }

    let providerSettings = domain.inboundProviderSettings;
    if (client.inbound.open) {
      try {
        providerSettings = { ...providerSettings, ...(await client.inbound.open({ domainId, host })) };
      } catch (err) {
        if (err instanceof InboundUnavailableError) throw new ApiError("capability_unavailable", err.message);
        throw new ApiError("provider_unavailable", `Provider couldn't route mail for ${host}: ${safeErrorMessage(err)}`);
      }
    }

    let webhookSecret: string | null = null;
    if (input.webhook_url) {
      const created = await upsertDomainEndpoint(caller.organizationId, domainId, input.webhook_url);
      webhookSecret = created.secret;
    } else if (existingEndpoint?.disabledAt) {
      await setDisabled(caller.organizationId, existingEndpoint.id, false);
    }

    const mergedRecords = mergeDnsRecords(kept, client.inbound.records(host));

    const [updated] = await db
      .update(domains)
      .set({
        inboundEnabled: true,
        inboundRetentionDays: input.retention_days ?? domain.inboundRetentionDays,
        inboundSubdomain: subdomain,
        inboundProviderSettings: providerSettings,
        dnsRecords: mergedRecords,
        updatedAt: new Date(),
      })
      .where(and(eq(domains.organizationId, caller.organizationId), eq(domains.id, domainId)))
      .returning();

    await recordActivity({
      organizationId: caller.organizationId,
      action: "domain.inbound.enabled",
      actor: caller.actor,
      appliesTo: domainId,
      subjectLabel: domain.name,
      metadata: { retentionDays: updated!.inboundRetentionDays },
    }).catch(() => {});

    const endpoint = await readDomainEndpoint(caller.organizationId, domainId);
    return { status: statusOf(updated!, providerAdapter, client, endpoint?.url ?? null), webhookSecret };
  }

  // Disabling stops new deliveries; mail already accepted still lives out its retention window
  // and the sweep purges it on the same schedule it would have anyway — see docs/api/conventions.
  // A null webhook_url removes the endpoint, so the URL stops being reported back.
  const existing = await readDomainEndpoint(caller.organizationId, domainId);
  const cleared = input.webhook_url === null;
  if (existing) {
    if (cleared) await deleteDomainEndpoint(caller.organizationId, domainId);
    else await setDisabled(caller.organizationId, existing.id, true);
  }
  const endpoint = cleared ? null : existing;

  const [updated] = await db
    .update(domains)
    .set({
      inboundEnabled: false,
      inboundSubdomain: subdomain,
      dnsRecords: withoutHost(domain.dnsRecords, previousHost),
      updatedAt: new Date(),
    })
    .where(and(eq(domains.organizationId, caller.organizationId), eq(domains.id, domainId)))
    .returning();

  await closeInboundRoute(domain, client).catch((err) =>
    log.warn(`taking down inbound routing for ${domain.name} failed: ${safeErrorMessage(err)}`),
  );

  await recordActivity({
    organizationId: caller.organizationId,
    action: "domain.inbound.disabled",
    actor: caller.actor,
    appliesTo: domainId,
    subjectLabel: domain.name,
  }).catch(() => {});

  return { status: statusOf(updated!, providerAdapter, client, endpoint?.url ?? null), webhookSecret: null };
}

/**
 * Follows a domain's cutover to another provider: takes down the old provider's route, opens the
 * new one and proposes its records. The cutover has already happened, so a failure is logged and
 * inbound is left for the owner to re-save.
 */
export async function moveInboundRoute(before: DomainRow, from: typeof providers.$inferSelect, to: typeof providers.$inferSelect): Promise<void> {
  if (!before.inboundEnabled) return;
  const host = inboundHost(before.name, before.inboundSubdomain);

  await closeInboundRoute(before, adapterFor(from)).catch((err) =>
    log.warn(`taking down ${before.name}'s inbound routing on its old provider failed: ${safeErrorMessage(err)}`),
  );

  const client = adapterFor(to);
  let settings: Record<string, string> = {};
  if (client.inbound?.open) {
    try {
      settings = await client.inbound.open({ domainId: before.id, host });
    } catch (err) {
      log.warn(`routing ${before.name}'s inbound mail on its new provider failed: ${safeErrorMessage(err)}`);
    }
  }

  const [current] = await db.select({ dnsRecords: domains.dnsRecords }).from(domains).where(eq(domains.id, before.id)).limit(1);
  if (!current) return;
  const dnsRecords = client.inbound ? mergeDnsRecords(withoutHost(current.dnsRecords, host), client.inbound.records(host)) : current.dnsRecords;
  await db.update(domains).set({ inboundProviderSettings: settings, dnsRecords, updatedAt: new Date() }).where(eq(domains.id, before.id));
}
