/** What an admin key reads about providers and organizations. Credentials never appear here. */
import { effectiveAddressLimits, type AddressLimits } from "@/lib/addresses/limits";
import { ADAPTER_KEYS, capabilitiesOf, isConfiguredFor } from "@/lib/providers/adapters";
import { assignmentSettingUp } from "./status";
import { QUOTA_WARN_SHARE } from "./quota";
import type { OrganizationRow } from "@/lib/db/schema";
import type { ProviderRow } from "./index";
import { CONVERSION_JOB_KEY, conversionJobOf, type ConversionJob } from "./conversion-state";

/** Most urgent first. The first one present is the provider's status. */
export const ADMIN_PROVIDER_ISSUES = ["needs_conversion", "credentials_failing", "backing_off", "setting_up", "quota"] as const;
export type AdminProviderIssue = (typeof ADMIN_PROVIDER_ISSUES)[number];

export const ADMIN_PROVIDER_STATUSES = ["ready", "converting", ...ADMIN_PROVIDER_ISSUES] as const;
export type AdminProviderStatus = (typeof ADMIN_PROVIDER_STATUSES)[number];

/** `shared` serves every organization, each isolated; `single` serves the one it lives in; `legacy` is an SES row awaiting conversion. */
export type AdminProviderKind = "shared" | "single" | "legacy";

export function adminProviderKind(provider: Pick<ProviderRow, "shared" | "adapter">): AdminProviderKind {
  if (provider.shared) return "shared";
  return capabilitiesOf(provider.adapter).sharing ? "legacy" : "single";
}

export interface IssueContext {
  healthOk: boolean | null | undefined;
  /** Share of the daily quota used, when known. */
  quotaShare: number | null;
  now: number;
}

/** Everything that needs an admin's attention on a provider, most urgent first. */
export function adminProviderIssues(provider: ProviderRow, context: IssueContext): AdminProviderIssue[] {
  const found = new Set<AdminProviderIssue>();
  if (adminProviderKind(provider) === "legacy") found.add("needs_conversion");
  if (ADAPTER_KEYS.includes(provider.adapter) && !isConfiguredFor(provider.adapter, provider.settings)) found.add("setting_up");
  if (context.healthOk === false) found.add("credentials_failing");
  if (provider.backoffUntil && provider.backoffUntil.getTime() > context.now) found.add("backing_off");
  if (context.quotaShare !== null && context.quotaShare >= QUOTA_WARN_SHARE) found.add("quota");
  return ADMIN_PROVIDER_ISSUES.filter((issue) => found.has(issue));
}

export interface AdminHealth {
  ok: boolean | null;
  detail: string | null;
  checked_at: string | null;
}

export interface AdminProvider {
  id: string;
  adapter: string;
  name: string;
  kind: "shared" | "single";
  organization_id: string | null;
  organization_count: number;
  default_for_new_organizations: boolean;
  identity: string | null;
  settings: Record<string, string>;
  concurrency: number;
  backoff_until: string | null;
  status: AdminProviderStatus;
  issues: AdminProviderIssue[];
  health: AdminHealth;
  conversion: ConversionJob | null;
  created_at: string;
  updated_at: string;
}

export interface AdminProviderContext {
  organizationCount: number;
  /** The one provider new organizations are onboarded onto, from service settings. */
  defaultProviderId?: string | null;
  health: { ok: boolean | null; detail: string | null; checkedAt: string } | null;
  quotaShare?: number | null;
  now?: number;
}

export function adminProviderStatus(provider: ProviderRow, issues: AdminProviderIssue[], now = Date.now()): AdminProviderStatus {
  const job = conversionJobOf(provider, now);
  if (issues[0] === "needs_conversion" && job?.state === "running" && !job.interrupted) return "converting";
  return issues[0] ?? "ready";
}

export function serializeAdminProvider(provider: ProviderRow, context: AdminProviderContext): AdminProvider {
  const { [CONVERSION_JOB_KEY]: _job, ...settings } = provider.settings;
  const now = context.now ?? Date.now();
  const issues = adminProviderIssues(provider, { healthOk: context.health?.ok, quotaShare: context.quotaShare ?? null, now });
  return {
    id: provider.id,
    adapter: provider.adapter,
    name: provider.name,
    kind: provider.shared ? "shared" : "single",
    organization_id: provider.shared ? null : provider.organizationId,
    organization_count: context.organizationCount,
    default_for_new_organizations: provider.id === context.defaultProviderId,
    identity: provider.providerIdentity,
    settings,
    concurrency: provider.concurrency,
    backoff_until: provider.backoffUntil?.toISOString() ?? null,
    status: adminProviderStatus(provider, issues, now),
    issues,
    health: {
      ok: context.health?.ok ?? null,
      detail: context.health?.detail ?? null,
      checked_at: context.health?.checkedAt ?? null,
    },
    conversion: conversionJobOf(provider, now),
    created_at: provider.createdAt.toISOString(),
    updated_at: provider.updatedAt.toISOString(),
  };
}

export const ASSIGNMENT_STATUSES = ["ready", "setting_up", "paused"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export interface AdminAssignment {
  organization_id: string;
  organization_name: string;
  /** The row the organization's domains bind to. */
  provider_id: string;
  default: boolean;
  domain_count: number;
  status: AssignmentStatus;
  created_at: string;
}

export function serializeAssignment(
  row: ProviderRow,
  organization: Pick<OrganizationRow, "id" | "name" | "providerId" | "suspendSource">,
  domainCount: number,
  parentBackoff: Date | null,
  now = Date.now(),
): AdminAssignment {
  const backoff = [row.backoffUntil, parentBackoff].some((until) => until && until.getTime() > now);
  let status: AssignmentStatus = "ready";
  if (backoff || (row.sharedProviderId && organization.suspendSource === "provider")) status = "paused";
  else if (assignmentSettingUp(row, domainCount)) status = "setting_up";
  return {
    organization_id: organization.id,
    organization_name: organization.name,
    provider_id: row.id,
    default: organization.providerId === row.id,
    domain_count: domainCount,
    status,
    created_at: row.createdAt.toISOString(),
  };
}

export interface AdminOrganization {
  id: string;
  name: string;
  slug: string;
  /** The assignment new domains bind to. */
  provider_id: string | null;
  /** The provider an admin manages it on: the shared provider for a shared row, else the row itself. */
  managed_provider_id: string | null;
  assignment_count: number;
  domain_count: number;
  suspension: { source: string; reason: string; suspended_at: string } | null;
  address_limit: number;
  address_daily_message_limit: number;
  /** The organization's own, or null while it follows the install's default. */
  address_limit_override: number | null;
  address_daily_message_limit_override: number | null;
  created_at: string;
  updated_at: string;
}

export function serializeAdminOrganization(
  org: OrganizationRow,
  context: { managedProviderId: string | null; assignmentCount: number; domainCount: number; limitDefaults: AddressLimits },
): AdminOrganization {
  const limits = effectiveAddressLimits(org, context.limitDefaults);
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    provider_id: org.providerId,
    managed_provider_id: context.managedProviderId,
    assignment_count: context.assignmentCount,
    domain_count: context.domainCount,
    suspension:
      org.suspendedAt && org.suspendSource
        ? { source: org.suspendSource, reason: org.suspendReason ?? "", suspended_at: org.suspendedAt.toISOString() }
        : null,
    address_limit: limits.active,
    address_daily_message_limit: limits.daily,
    address_limit_override: org.addressLimit,
    address_daily_message_limit_override: org.addressDailyMessageLimit,
    created_at: org.createdAt.toISOString(),
    updated_at: org.updatedAt.toISOString(),
  };
}

export interface AdminConversionPlan {
  provider_id: string;
  organization_id: string;
  parent_id: string | null;
  parent_name: string;
  configuration_set_name: string;
  identities: string[];
  permissions: string[];
  stages: { stage: string; done: boolean; calls: string[] }[];
  converted: boolean;
}

export function serializeConversionPlan(plan: {
  providerId: string;
  organizationId: string;
  parentId: string | null;
  parentName: string;
  resources: { configurationSetName: string; identities: string[] };
  permissions: string[];
  stages: { stage: string; done: boolean; calls: string[] }[];
  converted: boolean;
}): AdminConversionPlan {
  return {
    provider_id: plan.providerId,
    organization_id: plan.organizationId,
    parent_id: plan.parentId,
    parent_name: plan.parentName,
    configuration_set_name: plan.resources.configurationSetName,
    identities: plan.resources.identities,
    permissions: plan.permissions,
    stages: plan.stages,
    converted: plan.converted,
  };
}
