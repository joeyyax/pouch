/** Service-level providers that organizations send through isolated from each other. */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { domains, organizations, providers } from "@/lib/db/schema";
import { recordActivity, workerActor } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { ApiError } from "@/lib/api/errors";
import { newId } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { isConfiguredFor } from "@/lib/providers/adapters";
import { TENANT_UNREQUESTED } from "@/lib/providers/adapters/types";
import { readDefaultProviderId, setDefaultProviderId } from "@/lib/settings/service";
import { adapterFor, type ProviderRow } from "./index";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("providers:shared");

/** The organization id, as a name SES accepts: letters, digits, `-` and `_`, at most 64. */
export function tenantNameFor(organizationId: string): string {
  const clean = organizationId.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return (clean.startsWith("org_") ? clean : `org_${clean}`).slice(0, 64);
}

export async function sharedProvider(id: string): Promise<ProviderRow> {
  const [row] = await db
    .select()
    .from(providers)
    .where(and(eq(providers.id, id), eq(providers.shared, true)))
    .limit(1);
  if (!row) throw new ApiError("not_found", `No shared provider with id ${id}.`);
  return row;
}

async function assignmentRow(sharedId: string, organizationId: string, executor: Executor = db): Promise<ProviderRow | undefined> {
  const [row] = await executor
    .select()
    .from(providers)
    .where(and(eq(providers.sharedProviderId, sharedId), eq(providers.organizationId, organizationId)))
    .limit(1);
  return row;
}

/** A free provider name in the organization, starting from the shared provider's own. */
async function assignmentName(executor: Executor, organizationId: string, base: string): Promise<string> {
  const taken = await executor
    .select({ name: providers.name })
    .from(providers)
    .where(eq(providers.organizationId, organizationId));
  const names = new Set(taken.map((row) => row.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!names.has(candidate)) return candidate;
  }
}

export interface OnboardOptions {
  /** The assignment row's name. Defaults to a free name based on the shared provider's. */
  name?: string;
}

/**
 * Attaches an organization to a shared provider by inserting its assignment row, and makes that row the
 * organization's default when it has none. No provider call: the first domain creates its space at the provider.
 */
export async function onboardOrganization(
  sharedId: string,
  organizationId: string,
  actor: ActivityActor,
  options: OnboardOptions = {},
): Promise<{ provider: ProviderRow; created: boolean }> {
  const shared = await sharedProvider(sharedId);

  const result = await db.transaction(async (tx) => {
    const [org] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for("update")
      .limit(1);
    if (!org) throw new ApiError("not_found", `No organization with id ${organizationId}.`);

    const existing = await assignmentRow(shared.id, org.id, tx);
    if (existing) return { provider: existing, created: false };

    // Credentials and identity are read in the insert, so a rotation in between can't leave a stale copy.
    const [provider] = await tx
      .insert(providers)
      .values({
        id: newId("provider"),
        organizationId: org.id,
        adapter: shared.adapter,
        name: await assignmentName(tx, org.id, options.name ?? shared.name),
        credentials: sql`(select ${providers.credentials} from ${providers} where ${providers.id} = ${shared.id})`,
        settings: { tenantName: tenantNameFor(org.id), tenantState: TENANT_UNREQUESTED },
        providerIdentity: sql`(select ${providers.providerIdentity} from ${providers} where ${providers.id} = ${shared.id})`,
        concurrency: shared.concurrency,
        sharedProviderId: shared.id,
      })
      .returning();
    if (!provider) throw new ApiError("provider_unavailable", "The assignment couldn't be stored.");

    await tx
      .update(organizations)
      .set({ providerId: provider.id, updatedAt: new Date() })
      .where(and(eq(organizations.id, org.id), isNull(organizations.providerId)));
    return { provider, created: true };
  });

  if (result.created) {
    await recordActivity({
      organizationId,
      action: "provider.shared.attached",
      actor,
      appliesTo: result.provider.id,
      subjectLabel: result.provider.name,
      metadata: { sharedProviderId: shared.id },
    });
  }
  return result;
}

/** Detaches an organization. Refused while domains are bound; the provider side is removed first. */
export async function offboardOrganization(sharedId: string, organizationId: string, actor: ActivityActor): Promise<void> {
  const provider = await assignmentRow(sharedId, organizationId);
  if (!provider) return;

  const bound = await db
    .select({ name: domains.name })
    .from(domains)
    .where(or(eq(domains.providerId, provider.id), eq(domains.pendingProviderId, provider.id)));
  if (bound.length > 0) {
    const names = bound.map((domain) => domain.name);
    throw new ApiError(
      "provider_in_use",
      `The organization still has domains on ${provider.name}: ${names.join(", ")}. Move or delete them first.`,
      { detail: { domains: names } },
    );
  }

  await adapterFor(provider).setup?.teardown?.();
  await db.delete(providers).where(eq(providers.id, provider.id));

  await recordActivity({
    organizationId,
    action: "provider.shared.detached",
    actor,
    appliesTo: provider.id,
    subjectLabel: provider.name,
    metadata: { sharedProviderId: sharedId },
  });
}

/**
 * Points new organizations at a shared provider, or clears it with null. A single pointer is
 * what makes two defaults impossible; only a shared provider can hold it, which the column
 * can't say, so it's checked here.
 */
export async function setDefaultForNewOrganizations(providerId: string | null): Promise<void> {
  if (providerId !== null) await sharedProvider(providerId);
  await setDefaultProviderId(providerId);
}

/** Assigns a new organization the default provider. Never throws; an admin can assign one later. */
export async function onboardNewOrganization(organizationId: string): Promise<void> {
  const defaultProviderId = await readDefaultProviderId();
  if (!defaultProviderId) return;
  try {
    await onboardOrganization(defaultProviderId, organizationId, workerActor());
  } catch (err) {
    log.warn(`onboarding ${organizationId} onto ${defaultProviderId} failed: ${safeErrorMessage(err)}`);
  }
}

export interface SharedProviderView {
  id: string;
  name: string;
  adapter: string;
  identity: string | null;
  configured: boolean;
  /** New organizations are onboarded onto this one. */
  isDefault: boolean;
  organizationCount: number;
  createdAt: Date;
}

export async function listSharedProviders(): Promise<SharedProviderView[]> {
  const [rows, defaultProviderId] = await Promise.all([
    db.select().from(providers).where(eq(providers.shared, true)).orderBy(asc(providers.name)),
    readDefaultProviderId(),
  ]);
  if (rows.length === 0) return [];

  const counts = await db
    .select({ sharedId: providers.sharedProviderId, count: sql<number>`count(*)::int` })
    .from(providers)
    .where(inArray(providers.sharedProviderId, rows.map((row) => row.id)))
    .groupBy(providers.sharedProviderId);
  const countBy = new Map(counts.map((row) => [row.sharedId, row.count]));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    adapter: row.adapter,
    identity: row.providerIdentity,
    configured: isConfiguredFor(row.adapter, row.settings),
    isDefault: row.id === defaultProviderId,
    organizationCount: countBy.get(row.id) ?? 0,
    createdAt: row.createdAt,
  }));
}

export interface AssignmentBinding {
  organizationId: string;
  providerId: string;
  sharedProviderId: string;
  configured: boolean;
}

/** Every organization's assignment rows, for the operator's organizations screen. An assignment with no domains has nothing to set up. */
export async function listAssignmentBindings(): Promise<AssignmentBinding[]> {
  const rows = await db
    .select({
      organizationId: providers.organizationId,
      providerId: providers.id,
      sharedProviderId: providers.sharedProviderId,
      adapter: providers.adapter,
      settings: providers.settings,
      hasDomains: sql<boolean>`exists (select 1 from "domains" "d" where "d"."provider_id" = "providers"."id" or "d"."pending_provider_id" = "providers"."id")`,
    })
    .from(providers)
    .where(sql`${providers.sharedProviderId} is not null`);
  return rows.flatMap((row) =>
    row.organizationId === null
      ? []
      : [
          {
            organizationId: row.organizationId,
            providerId: row.providerId,
            sharedProviderId: row.sharedProviderId ?? "",
            configured: !row.hasDomains || isConfiguredFor(row.adapter, row.settings),
          },
        ],
  );
}
