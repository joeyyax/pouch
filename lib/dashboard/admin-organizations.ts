import { asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { domains, organizations, providers } from "@/lib/db/schema";
import { listSharedProviders } from "@/lib/providers/shared";
import { assignmentSettingUp } from "@/lib/providers/status";
import type { OrganizationSuspension } from "@/lib/suspension";
import { adapterLabel } from "@/lib/dashboard/views/domains";
import { effectiveAddressLimits, readAddressLimitDefaults, type AddressLimits } from "@/lib/addresses/limits";

export interface OrganizationProviderView {
  /** The provider's admin page: the shared provider for a tenant, else the row itself. */
  managedProviderId: string;
  name: string;
  adapterLabel: string;
  /** A tenant with domains whose setup hasn't finished. */
  settingUp: boolean;
}

export interface OperatorOrganizationView {
  id: string;
  name: string;
  slug: string;
  domainCount: number;
  suspension: OrganizationSuspension | null;
  /** The organization's assigned provider. Null means it can't send. */
  provider: OrganizationProviderView | null;
  addressLimits: AddressLimitsView;
}

export interface AddressLimitsView extends AddressLimits {
  /** The organization's own, or null while it follows the install's default. */
  activeOverride: number | null;
  dailyOverride: number | null;
}

export interface SharedProviderOption {
  id: string;
  name: string;
}

export interface OrganizationsForOperator {
  organizations: OperatorOrganizationView[];
  /** The install's address limits, for an organization without its own. */
  addressLimitDefaults: AddressLimits;
  sharedProviders: SharedProviderOption[];
  /** The provider a new organization gets. */
  defaultProvider: SharedProviderOption | null;
}

/** Every organization, suspended ones first. */
export async function listOrganizationsForOperator(): Promise<OrganizationsForOperator> {
  const assignment = alias(providers, "assignment");
  const parent = alias(providers, "parent");
  const [shared, limitDefaults, rows] = await Promise.all([
    listSharedProviders(),
    readAddressLimitDefaults(),
    db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        suspendedAt: organizations.suspendedAt,
        suspendReason: organizations.suspendReason,
        suspendSource: organizations.suspendSource,
        suspendDetail: organizations.suspendDetail,
        addressLimit: organizations.addressLimit,
        addressDailyMessageLimit: organizations.addressDailyMessageLimit,
        assignmentId: assignment.id,
        assignmentName: assignment.name,
        assignmentAdapter: assignment.adapter,
        assignmentSettings: assignment.settings,
        parentId: parent.id,
        parentName: parent.name,
        domainCount: sql<number>`(select count(*)::int from ${domains} where ${domains.organizationId} = ${organizations.id})`,
      })
      .from(organizations)
      .leftJoin(assignment, eq(assignment.id, organizations.providerId))
      .leftJoin(parent, eq(parent.id, assignment.sharedProviderId))
      .orderBy(sql`${organizations.suspendedAt} is null`, asc(organizations.name)),
  ]);

  const views = rows.map((row): OperatorOrganizationView => {
    let provider: OrganizationProviderView | null = null;
    if (row.assignmentId && row.assignmentAdapter && row.assignmentSettings) {
      provider = {
        managedProviderId: row.parentId ?? row.assignmentId,
        name: row.parentName ?? row.assignmentName ?? row.assignmentId,
        adapterLabel: adapterLabel(row.assignmentAdapter),
        settingUp: assignmentSettingUp(
          { sharedProviderId: row.parentId, adapter: row.assignmentAdapter, settings: row.assignmentSettings },
          row.domainCount,
        ),
      };
    }
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      domainCount: row.domainCount,
      suspension:
        row.suspendedAt && row.suspendSource
          ? {
              suspendedAt: row.suspendedAt,
              source: row.suspendSource,
              reason: row.suspendReason ?? "",
              detail: row.suspendDetail ?? null,
            }
          : null,
      provider,
      addressLimits: {
        ...effectiveAddressLimits(row, limitDefaults),
        activeOverride: row.addressLimit,
        dailyOverride: row.addressDailyMessageLimit,
      },
    };
  });

  const onboard = shared.find((provider) => provider.isDefault);
  return {
    organizations: views,
    addressLimitDefaults: limitDefaults,
    sharedProviders: shared.map(({ id, name }) => ({ id, name })),
    defaultProvider: onboard ? { id: onboard.id, name: onboard.name } : null,
  };
}

/** The name of the provider an organization sends through, or null. */
export async function assignedProviderName(organizationId: string): Promise<string | null> {
  const parent = alias(providers, "parent");
  const [row] = await db
    .select({ name: sql<string>`coalesce(${parent.name}, ${providers.name})` })
    .from(organizations)
    .innerJoin(providers, eq(providers.id, organizations.providerId))
    .leftJoin(parent, eq(parent.id, providers.sharedProviderId))
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.name ?? null;
}
