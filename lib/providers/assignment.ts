/** Which providers an organization's domains may bind to, and which one is its default. */
import { and, eq, isNull } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { organizations, providers } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { ApiError } from "@/lib/api/errors";
import { newId } from "@/lib/ids";
import { capabilitiesOf } from "@/lib/providers/adapters";
import type { ProviderSettings } from "@/lib/providers/adapters/types";
import {
  assertNameAvailable,
  encryptCredentials,
  isUniqueViolation,
  nameConflictError,
  validateCredentials,
  validateSettings,
  verifyOrThrow,
  type ProviderRow,
} from "./index";
import { offboardOrganization, onboardOrganization } from "./shared";

export interface AssignOptions {
  /** Makes the assignment the default even when the organization already has one. */
  default?: boolean;
}

async function lockOrganization(executor: Executor, organizationId: string): Promise<void> {
  const [org] = await executor
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update")
    .limit(1);
  if (!org) throw new ApiError("not_found", `No organization with id ${organizationId}.`, { field: "organization_id" });
}

async function providerRow(id: string): Promise<ProviderRow> {
  const [row] = await db.select().from(providers).where(eq(providers.id, id)).limit(1);
  if (!row || row.sharedProviderId) throw new ApiError("not_found", `No provider with id ${id}.`);
  return row;
}

/**
 * Gives an organization a provider its domains can bind to. On a shareable provider that's a
 * assignment row, with no provider call. A provider that can't be shared serves only the organization it
 * was created in.
 */
export async function assignProvider(
  providerId: string,
  organizationId: string,
  actor: ActivityActor,
  options: AssignOptions = {},
): Promise<ProviderRow> {
  const provider = await providerRow(providerId);

  let assignment: ProviderRow;
  if (provider.shared) {
    ({ provider: assignment } = await onboardOrganization(provider.id, organizationId, actor));
  } else if (provider.organizationId === organizationId) {
    assignment = provider;
  } else {
    throw new ApiError("validation_failed", `Provider ${provider.name} can serve only the organization it was created in.`, {
      field: "organization_id",
    });
  }

  if (options.default) await setDefaultProvider(organizationId, assignment.id, actor);
  else await setDefaultIfUnset(organizationId, assignment.id);
  return assignment;
}

/** Removes an organization's assignment on a provider. Refused while domains are bound. */
export async function unassignProvider(providerId: string, organizationId: string, actor: ActivityActor): Promise<void> {
  const provider = await providerRow(providerId);
  if (!provider.shared) {
    throw new ApiError("validation_failed", `Provider ${provider.name} serves only its own organization. Delete the provider instead.`);
  }
  await offboardOrganization(provider.id, organizationId, actor);
}

async function setDefaultIfUnset(organizationId: string, assignmentId: string): Promise<void> {
  await db
    .update(organizations)
    .set({ providerId: assignmentId, updatedAt: new Date() })
    .where(and(eq(organizations.id, organizationId), isNull(organizations.providerId)));
}

/** Points the organization's new domains at one of its assignments. */
export async function setDefaultProvider(organizationId: string, assignmentId: string, actor: ActivityActor): Promise<void> {
  const [assignment] = await db
    .select()
    .from(providers)
    .where(and(eq(providers.id, assignmentId), eq(providers.organizationId, organizationId), eq(providers.shared, false)))
    .limit(1);
  if (!assignment) {
    throw new ApiError("not_found", `No provider with id ${assignmentId} is assigned to this organization.`, {
      field: "provider_id",
    });
  }

  const [changed] = await db
    .update(organizations)
    .set({ providerId: assignment.id, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning({ id: organizations.id });
  if (!changed) throw new ApiError("not_found", `No organization with id ${organizationId}.`, { field: "organization_id" });

  await recordActivity({
    organizationId,
    action: "provider.default.changed",
    actor,
    appliesTo: assignment.id,
    subjectLabel: assignment.name,
  });
}

export interface SingleOrgProviderInput {
  adapter: string;
  name: string;
  credentials: Record<string, string>;
  settings?: ProviderSettings;
  concurrency?: number;
}

/** Creates a provider for an adapter that can't be shared, in the one organization it serves. */
export async function createSingleOrgProvider(
  input: SingleOrgProviderInput,
  organizationId: string,
  actor: ActivityActor,
  options: AssignOptions = {},
): Promise<{ provider: ProviderRow; verified: boolean | null }> {
  if (capabilitiesOf(input.adapter).sharing) {
    throw new ApiError("validation_failed", `Provider adapter "${input.adapter}" serves every organization. Add it as a shared provider and assign it.`, {
      field: "adapter",
    });
  }
  const credentials = validateCredentials(input.adapter, input.credentials);
  const settings = validateSettings(input.adapter, input.settings ?? {});
  await assertNameAvailable(organizationId, input.name);

  const id = newId("provider");
  const verified = await verifyOrThrow(input.adapter, credentials, settings, id);

  let provider: ProviderRow | undefined;
  try {
    provider = await db.transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      const [row] = await tx
        .insert(providers)
        .values({
          id,
          organizationId,
          adapter: input.adapter,
          name: input.name,
          credentials: encryptCredentials(credentials),
          settings,
          concurrency: input.concurrency,
        })
        .returning();
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw nameConflictError(input.name);
    throw err;
  }
  if (!provider) throw new ApiError("provider_unavailable", "The provider couldn't be stored.");

  await recordActivity({
    organizationId,
    action: "provider.created",
    actor,
    appliesTo: provider.id,
    subjectLabel: provider.name,
    metadata: { adapter: provider.adapter, verified },
  });

  if (options.default) await setDefaultProvider(organizationId, provider.id, actor);
  else await setDefaultIfUnset(organizationId, provider.id);
  return { provider, verified };
}
