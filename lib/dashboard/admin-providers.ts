/** Read models for Admin → Providers. Never reads credentials. */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, organizations, providers } from "@/lib/db/schema";
import type { ProviderRow } from "@/lib/providers";
import { planConversion, type ConversionStage } from "@/lib/providers/convert";
import { providerContext, type ProviderContext } from "@/lib/providers/admin-read";
import { adminProviderIssues, adminProviderKind, type AdminProviderIssue, type AdminProviderKind } from "@/lib/providers/admin-serialize";
import { ApiError } from "@/lib/api/errors";
import { ADAPTER_KEYS, capabilitiesOf, isConfiguredFor } from "@/lib/providers/adapters";
import { assignmentSettingUp } from "@/lib/providers/status";
import { webhookUrl } from "@/lib/webhooks/url";
import { credentialFieldSpecsOf } from "./service";
import { adapterLabel } from "@/lib/dashboard/views/domains";
import type { CredentialFieldSpec } from "@/lib/dashboard/views/service";

export type { AdminProviderIssue, AdminProviderKind };

export interface AdminProviderOrganization {
  id: string;
  name: string;
}

export interface AdminProviderListItem {
  id: string;
  name: string;
  adapter: string;
  adapterLabel: string;
  kind: AdminProviderKind;
  /** New organizations are onboarded onto this one. */
  isDefault: boolean;
  /** Tenants on a shared provider. */
  organizationCount: number;
  /** The one organization a single or legacy provider serves. */
  organization: AdminProviderOrganization | null;
  issues: AdminProviderIssue[];
}

export interface AdminAdapterOption {
  adapter: string;
  adapterLabel: string;
  /** Serves every organization as a tenant, so it's created without one. */
  sharing: boolean;
  credentialFieldSpecs: CredentialFieldSpec[];
}

const kindOf = adminProviderKind;

/** Rows an admin manages: shared providers and every non-assignment row. Assignment rows are assignments. */
async function providerRows(ids?: string[]): Promise<ProviderRow[]> {
  return db
    .select()
    .from(providers)
    .where(and(isNull(providers.sharedProviderId), ids ? inArray(providers.id, ids) : undefined))
    .orderBy(asc(providers.name), asc(providers.id));
}

export async function listAdminProviders(): Promise<AdminProviderListItem[]> {
  const rows = await providerRows();
  return listItems(rows, await providerContext(rows));
}

function listItem(row: ProviderRow, context: ProviderContext, organization: { id: string; name: string } | null): AdminProviderListItem {
  const kind = kindOf(row);
  return {
    id: row.id,
    name: row.name,
    adapter: row.adapter,
    adapterLabel: adapterLabel(row.adapter),
    kind,
    isDefault: row.id === context.defaultProviderId,
    organizationCount: context.organizationCount.get(row.id) ?? 1,
    organization: kind === "shared" ? null : organization,
    issues: adminProviderIssues(row, {
      healthOk: context.health.get(row.id)?.ok,
      quotaShare: context.quotaShare.get(row.id) ?? null,
      now: context.now,
    }),
  };
}

async function listItems(rows: ProviderRow[], context: ProviderContext): Promise<AdminProviderListItem[]> {
  if (rows.length === 0) return [];
  const orgs = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(inArray(organizations.id, [...new Set(rows.flatMap((row) => (row.organizationId === null ? [] : [row.organizationId])))]));
  const orgBy = new Map(orgs.map((org) => [org.id, org]));
  return rows.map((row) => listItem(row, context, row.organizationId === null ? null : (orgBy.get(row.organizationId) ?? null)));
}

export interface AssignedOrganization {
  id: string;
  name: string;
  slug: string;
  /** The row the organization's domains bind to. */
  assignmentId: string;
  domainCount: number;
  /** The provider paused it, or an admin suspended it. */
  paused: boolean;
  /** A domain on this provider hasn't finished setup. */
  settingUp: boolean;
}

export interface ConversionView {
  /** Why it can't run yet, when it can't. */
  blocked: string | null;
  parentName: string | null;
  parentExists: boolean;
  identities: string[];
  configurationSetName: string | null;
  permissions: string[];
  stages: { stage: ConversionStage; done: boolean }[];
}

export interface AdminProviderDetail extends AdminProviderListItem {
  identity: string | null;
  createdAt: Date;
  updatedAt: Date;
  health: { ok: boolean | null; detail: string | null; checkedAt: Date | null };
  /** False for an adapter with no setup step. */
  hasSetup: boolean;
  configured: boolean;
  backoffUntil: Date | null;
  credentialFieldSpecs: CredentialFieldSpec[];
  /** For adapters whose webhooks are configured by hand. */
  webhook: { url: string; keySet: boolean } | null;
  organizations: AssignedOrganization[];
  /** Organizations with no provider yet, for a shared provider's assign picker. */
  assignable: AdminProviderOrganization[];
  conversion: ConversionView | null;
  /** Whether an identity already at the provider can be taken over. Admin-only either way. */
  canAdopt: boolean;
}

async function assignedOrganizations(row: ProviderRow): Promise<AssignedOrganization[]> {
  const assignments =
    row.shared
      ? await db
          .select({ id: providers.id, organizationId: providers.organizationId, adapter: providers.adapter, settings: providers.settings })
          .from(providers)
          .where(eq(providers.sharedProviderId, row.id))
      : [{ id: row.id, organizationId: row.organizationId, adapter: row.adapter, settings: row.settings }];
  if (assignments.length === 0) return [];

  const assignmentIds = assignments.map((entry) => entry.id);
  const [orgs, domainRows] = await Promise.all([
    db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, suspendedAt: organizations.suspendedAt })
      .from(organizations)
      .where(inArray(organizations.id, assignments.flatMap((entry) => (entry.organizationId === null ? [] : [entry.organizationId])))),
    db
      .select({
        providerId: domains.providerId,
        pendingProviderId: domains.pendingProviderId,
        status: domains.status,
      })
      .from(domains)
      .where(or(inArray(domains.providerId, assignmentIds), inArray(domains.pendingProviderId, assignmentIds))),
  ]);
  const orgBy = new Map(orgs.map((org) => [org.id, org]));

  return assignments
    .flatMap((entry) => {
      const org = entry.organizationId === null ? undefined : orgBy.get(entry.organizationId);
      if (!org) return [];
      const own = domainRows.filter((domain) => domain.providerId === entry.id || domain.pendingProviderId === entry.id);
      const unfinished = own.some((domain) => domain.status !== "verified" || domain.pendingProviderId === entry.id);
      const tenantPending = assignmentSettingUp({ ...entry, sharedProviderId: row.shared ? row.id : null }, own.length);
      return [
        {
          id: org.id,
          name: org.name,
          slug: org.slug,
          assignmentId: entry.id,
          domainCount: own.filter((domain) => domain.providerId === entry.id).length,
          paused: org.suspendedAt !== null,
          settingUp: unfinished || tenantPending,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function assignableOrganizations(row: ProviderRow): Promise<AdminProviderOrganization[]> {
  if (!row.shared) return [];
  return db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(
      sql`not exists (select 1 from ${providers} "pa" where "pa"."organization_id" = ${organizations.id} and "pa"."shared" = false)`,
    )
    .orderBy(asc(organizations.name));
}

async function conversionFor(row: ProviderRow): Promise<ConversionView | null> {
  if (kindOf(row) !== "legacy") return null;
  try {
    const plan = await planConversion(row.id);
    return {
      blocked: null,
      parentName: plan.parentName,
      parentExists: plan.parentId !== null,
      identities: plan.resources.identities,
      configurationSetName: plan.resources.configurationSetName || null,
      permissions: plan.permissions,
      stages: plan.stages.map(({ stage, done }) => ({ stage, done })),
    };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return {
      blocked: error.message,
      parentName: null,
      parentExists: false,
      identities: [],
      configurationSetName: null,
      permissions: [],
      stages: [],
    };
  }
}

/** One provider an admin manages, or null for an unknown id or an assignment row. */
export async function readAdminProvider(id: string): Promise<AdminProviderDetail | null> {
  const [row] = await providerRows([id]);
  if (!row) return null;
  const context = await providerContext([row]);
  const [[item], orgs, assignable, conversion] = await Promise.all([
    listItems([row], context),
    assignedOrganizations(row),
    assignableOrganizations(row),
    conversionFor(row),
  ]);
  const record = context.health.get(row.id) ?? null;
  const known = ADAPTER_KEYS.includes(row.adapter);
  const capabilities = known ? capabilitiesOf(row.adapter) : null;

  return {
    ...item!,
    organizationCount: orgs.length,
    identity: row.providerIdentity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    health: { ok: record?.ok ?? null, detail: record?.detail ?? null, checkedAt: record ? new Date(record.checkedAt) : null },
    hasSetup: row.shared && Boolean(capabilities?.webhooksViaApi),
    configured: known ? isConfiguredFor(row.adapter, row.settings) : false,
    backoffUntil: row.backoffUntil,
    credentialFieldSpecs: credentialFieldSpecsOf(row.adapter),
    webhook:
      capabilities && !capabilities.webhooksViaApi
        ? { url: webhookUrl(row.adapter, row.id), keySet: Boolean(row.settings.webhookPublicKey) }
        : null,
    organizations: orgs,
    assignable,
    conversion,
    canAdopt: Boolean(capabilities?.adoptionViaApi),
  };
}

/** Adapters an admin can add a provider for. */
export function listAdminAdapters(): AdminAdapterOption[] {
  return ADAPTER_KEYS.map((adapter) => ({
    adapter,
    adapterLabel: adapterLabel(adapter),
    sharing: Boolean(capabilitiesOf(adapter).sharing),
    credentialFieldSpecs: credentialFieldSpecsOf(adapter),
  }));
}

/** Every organization, for the add-provider form's organization picker. */
export async function listOrganizationOptions(): Promise<AdminProviderOrganization[]> {
  return db.select({ id: organizations.id, name: organizations.name }).from(organizations).orderBy(asc(organizations.name));
}
