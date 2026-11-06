/** Mirrors a shared provider's tenant status into organization suspensions. */
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import type { ActivityActor } from "@/lib/activity/types";
import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { providers } from "@/lib/db/schema";
import { providerActor, recordActivity } from "@/lib/activity/record";
import { logger } from "@/lib/logger";
import { sendPushAlert } from "@/lib/notifications/push/push";
import type { Adapter, TenantSendingStatus, TenantStatusEvent } from "@/lib/providers/adapters/types";
import { releaseOrganizationSuspension, suspendOrganization } from "@/lib/suspension";
import { openFindingsFor, recordProviderFinding } from "@/lib/reputation/provider-findings";
import type { OrganizationProviderRow, ProviderRow } from "./index";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("providers:tenant-status");

export const PROVIDER_PAUSED_REASON = "The email provider paused sending for this organization.";

export interface TenantStatusCounts {
  applied: number;
  ignored: number;
}

async function tenantFor(sharedId: string, event: TenantStatusEvent): Promise<OrganizationProviderRow | undefined> {
  const [row] = await db
    .select()
    .from(providers)
    .where(
      and(
        eq(providers.sharedProviderId, sharedId),
        isNotNull(providers.organizationId),
        or(
          sql`${providers.settings}->>'tenantArn' = ${event.tenantRef}`,
          event.tenantName ? sql`${providers.settings}->>'tenantName' = ${event.tenantName}` : undefined,
        ),
      ),
    )
    .limit(1);
  return row as OrganizationProviderRow | undefined;
}

/** A failed read answers 503, which SNS redelivers. */
async function readStatus(tenants: NonNullable<Adapter["tenants"]>, tenantName: string): Promise<TenantSendingStatus | null> {
  try {
    return await tenants.status(tenantName);
  } catch (err) {
    log.warn(`reading tenant ${tenantName} failed, asking for redelivery: ${safeErrorMessage(err)}`);
    throw new ApiError("provider_unavailable", "The provider's tenant status couldn't be read. Retry the event.");
  }
}

/** The record SES puts under `detail.data`, when it's there. */
function recordOf(event: TenantStatusEvent): Record<string, unknown> {
  const data = event.detail.data as { origin?: unknown; record?: { status?: unknown; cause?: unknown } } | undefined;
  return { origin: data?.origin ?? null, status: data?.record?.status ?? null, cause: data?.record?.cause ?? null };
}

/**
 * The event says something changed; the provider's current status decides what to do, so a
 * delayed or replayed event can't undo a newer one.
 */
export async function applyTenantStatus(
  shared: ProviderRow,
  adapter: Adapter,
  events: TenantStatusEvent[],
): Promise<TenantStatusCounts> {
  const counts: TenantStatusCounts = { applied: 0, ignored: 0 };
  const actor = providerActor(shared.id, shared.name);

  for (const event of events) {
    const tenant = await tenantFor(shared.id, event);
    const tenantName = tenant?.settings.tenantName;
    if (!tenant || !tenantName || !adapter.tenants) {
      log.warn(`no tenant on ${shared.id} matches ${event.tenantRef}`);
      counts.ignored += 1;
      continue;
    }

    if (event.kind === "sending_disabled") {
      const status = await readStatus(adapter.tenants, tenantName);
      if (status === "enabled") {
        counts.ignored += 1;
        continue;
      }
      await suspendOrganization(
        tenant.organizationId,
        { source: "provider", reason: PROVIDER_PAUSED_REASON, detail: { tenant: tenantName, ...recordOf(event) } },
        actor,
      );
      counts.applied += 1;
      continue;
    }

    if (event.kind === "sending_enabled") {
      const status = await readStatus(adapter.tenants, tenantName);
      if (status !== "enabled") {
        counts.ignored += 1;
        continue;
      }
      await releaseOrganizationSuspension(tenant.organizationId, actor, undefined, { onlySource: "provider" });
      counts.applied += 1;
      continue;
    }

    // Findings raise the reputation standing, never a pause: under the standard policy SES pauses on its own.
    const metadata = event.detail.metadata as { impact?: unknown; type?: unknown } | undefined;
    await applyFinding(actor, tenant, {
      kind: event.kind,
      type: typeof metadata?.type === "string" ? metadata.type : null,
      impact: typeof metadata?.impact === "string" ? metadata.impact : null,
      description: typeof event.detail.data === "string" ? event.detail.data : null,
    });
    counts.applied += 1;
  }

  return counts;
}

interface FindingChange {
  kind: "finding_opened" | "finding_closed";
  type: string | null;
  impact: string | null;
  description: string | null;
  openedAt?: Date | null;
}

/** Records a finding, and logs and alerts only when it opened or closed. */
async function applyFinding(actor: ActivityActor, tenant: OrganizationProviderRow, change: FindingChange): Promise<boolean> {
  const changed = await recordProviderFinding({ organizationId: tenant.organizationId, providerId: tenant.id, ...change });
  if (!changed) return false;
  await recordActivity({
    organizationId: tenant.organizationId,
    action: change.kind === "finding_opened" ? "provider.finding.opened" : "provider.finding.closed",
    actor,
    appliesTo: tenant.id,
    subjectLabel: tenant.name,
    metadata: { impact: change.impact, type: change.type, description: change.description },
  });
  if (change.kind === "finding_opened" && change.impact === "HIGH") {
    await sendPushAlert({
      title: `Reputation finding: ${tenant.settings.tenantName ?? tenant.name}`,
      message: change.description ?? "SES opened a high-impact finding.",
      tags: ["warning", "email"],
      priority: 4,
    }).catch((err: Error) => log.warn(`couldn't send the finding alert: ${safeErrorMessage(err)}`));
  }
  return true;
}

export interface FindingReconcileCounts {
  opened: number;
  closed: number;
}

/**
 * The backstop for lost finding events: opens what the provider lists and, when the list was
 * read in full, closes what it no longer lists.
 */
export async function reconcileTenantFindings(
  shared: ProviderRow,
  adapter: Adapter,
  maxPages: number,
  spacing: () => Promise<void>,
): Promise<FindingReconcileCounts | null> {
  const listed = await adapter.tenants?.findings?.(maxPages, spacing);
  if (!listed) return null;
  const counts: FindingReconcileCounts = { opened: 0, closed: 0 };
  const actor = providerActor(shared.id, shared.name);
  const tenants = (await db
    .select()
    .from(providers)
    .where(and(eq(providers.sharedProviderId, shared.id), isNotNull(providers.organizationId)))) as OrganizationProviderRow[];
  const byArn = new Map(tenants.map((tenant) => [tenant.settings.tenantArn, tenant]));
  const byName = new Map(tenants.map((tenant) => [tenant.settings.tenantName, tenant]));

  const seen = new Set<string>();
  for (const finding of listed.findings) {
    const tenant = byArn.get(finding.tenantRef) ?? (finding.tenantName ? byName.get(finding.tenantName) : undefined);
    if (!tenant) continue;
    seen.add(`${tenant.id} ${finding.type}`);
    if (await applyFinding(actor, tenant, { kind: "finding_opened", ...finding })) counts.opened += 1;
  }
  if (!listed.complete) return counts;

  const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
  for (const open of await openFindingsFor(tenants.map((tenant) => tenant.id))) {
    const tenant = byId.get(open.providerId);
    if (!tenant || seen.has(`${tenant.id} ${open.type}`)) continue;
    const change = { kind: "finding_closed" as const, type: open.type, impact: null, description: null };
    if (await applyFinding(actor, tenant, change)) counts.closed += 1;
  }
  return counts;
}
