import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, organizations, users, type OrganizationRow } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { ROLES } from "@/lib/auth/permissions";
import { newId } from "@/lib/ids";
import { slugify } from "@/lib/slug";
import type { OrganizationSummary, OwnerSummary } from "./summary";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import type { UpdateOrganizationSettingsRequest } from "@/lib/schemas/organization-settings";
import type { CreateOrganizationRequest } from "@/lib/schemas/organization";
import { onboardNewOrganization } from "@/lib/providers/shared";
import { countAddresses, type AddressStatusCounts } from "@/lib/addresses/manage";
import { readSetting } from "@/lib/settings/values";
import { effectiveAddressLimits, readAddressLimitDefaults, type AddressLimits } from "@/lib/addresses/limits";

export type { OrganizationSummary, OwnerSummary } from "./summary";

/** Conventional default (Postmark keeps content 45 days). Configurable per organization from 7 to the install's ceiling. */
export const DEFAULT_BODY_RETENTION_DAYS = 45;

/** The install's ceiling on body retention, in days. */
export function retentionCeiling(): Promise<number> {
  return readSetting("body_retention_max_days");
}

/**
 * The days an organization's bodies stay readable: its setting, held to the install's ceiling.
 * A missing row falls back to the default, so a config bug never silently keeps a body forever.
 */
/** Null is the service's own mail, kept for the default window under the ceiling. */
export async function retentionDaysFor(organizationId: string | null): Promise<number> {
  if (organizationId === null) return Math.min(DEFAULT_BODY_RETENTION_DAYS, await retentionCeiling());
  const [[row], ceiling] = await Promise.all([
    db
      .select({ bodyRetentionDays: organizations.bodyRetentionDays })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1),
    retentionCeiling(),
  ]);
  return Math.min(row?.bodyRetentionDays ?? DEFAULT_BODY_RETENTION_DAYS, ceiling);
}

/** Who is asking. An API key and a dashboard session differ only in what they're limited to. */
export interface OrganizationCaller {
  organizationId: string;
  /** Domains the caller is limited to. Empty means every domain. */
  domainIds: string[];
  actor: ActivityActor;
}

export interface SerializedOrganization {
  id: string;
  name: string;
  slug: string;
  body_retention_days: number;
  /** The install's ceiling. Bodies stay readable for the smaller of the two. */
  body_retention_max_days: number;
  address_limit: number;
  address_daily_message_limit: number;
  suspended: boolean;
  created_at: string;
  updated_at: string;
  /** With `include=address_counts`. */
  address_counts?: AddressStatusCounts;
}

function serializeOrganization(row: OrganizationRow, ceiling: number, limitDefaults: AddressLimits): SerializedOrganization {
  const limits = effectiveAddressLimits(row, limitDefaults);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    body_retention_days: row.bodyRetentionDays,
    body_retention_max_days: ceiling,
    address_limit: limits.active,
    address_daily_message_limit: limits.daily,
    suspended: Boolean(row.suspendedAt),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** Settings are organization-wide, so a key limited to domains can't read or change them. */
function assertMayManageOrganization(caller: OrganizationCaller): void {
  if (caller.domainIds.length > 0) {
    throw new ApiError("key_not_scoped", "This key is limited to domains, so it can't read organization settings.");
  }
}

async function organizationRow(organizationId: string): Promise<OrganizationRow> {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!row) throw new ApiError("not_found", `No organization with id ${organizationId}.`);
  return row;
}

export async function readOrganizationRecord(caller: OrganizationCaller, options: { addressCounts?: boolean } = {}): Promise<SerializedOrganization> {
  assertMayManageOrganization(caller);
  const [row, ceiling, limitDefaults, addressCounts] = await Promise.all([
    organizationRow(caller.organizationId),
    retentionCeiling(),
    readAddressLimitDefaults(),
    options.addressCounts ? countAddresses(caller.organizationId) : undefined,
  ]);
  return { ...serializeOrganization(row, ceiling, limitDefaults), ...(addressCounts ? { address_counts: addressCounts } : {}) };
}

/** Changes the organization's name or how long its bodies stay readable. Each change is recorded. */
export async function updateOrganization(
  caller: OrganizationCaller,
  patch: UpdateOrganizationSettingsRequest,
): Promise<SerializedOrganization> {
  assertMayManageOrganization(caller);
  const [before, ceiling, limitDefaults] = await Promise.all([organizationRow(caller.organizationId), retentionCeiling(), readAddressLimitDefaults()]);
  if (patch.body_retention_days !== undefined && patch.body_retention_days > ceiling) {
    throw new ApiError("validation_failed", `Field "body_retention_days" can't be above ${ceiling}, this install's ceiling.`, {
      field: "body_retention_days",
      detail: { max: ceiling },
    });
  }

  const [row] = await db
    .update(organizations)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.body_retention_days !== undefined ? { bodyRetentionDays: patch.body_retention_days } : {}),
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, caller.organizationId))
    .returning();
  if (!row) throw new ApiError("provider_unavailable", "The organization couldn't be updated.");

  if (patch.name !== undefined && patch.name !== before.name) {
    await recordActivity({
      organizationId: caller.organizationId,
      action: "settings.name.changed",
      actor: caller.actor,
      metadata: { from: before.name, to: row.name },
    });
  }
  if (patch.body_retention_days !== undefined && patch.body_retention_days !== before.bodyRetentionDays) {
    await recordActivity({
      organizationId: caller.organizationId,
      action: "settings.retention.changed",
      actor: caller.actor,
      metadata: { from: before.bodyRetentionDays, to: row.bodyRetentionDays },
    });
  }

  return serializeOrganization(row, ceiling, limitDefaults);
}

/**
 * Creates an organization, its creator's owner membership and its assignment to the default
 * provider. One definition for `POST /v1/admin/organizations`, the Admin settings →
 * Organizations screen and a signed-in user's "Add organization". Onboarding is best-effort: an install with no default provider gets an
 * organization an admin assigns by hand.
 */
export async function provisionOrganization(
  request: CreateOrganizationRequest,
  ownerUserId: string,
  actor: ActivityActor,
): Promise<CreatedOrganization> {
  const organization = await createOrganization(request, ownerUserId);
  await onboardNewOrganization(organization.id);

  await recordActivity({
    organizationId: organization.id,
    action: "organization.created",
    actor,
    appliesTo: organization.id,
    subjectLabel: organization.name,
    metadata: { slug: organization.slug },
  });
  return organization;
}

/** Why a signed-in user can't start an organization under each mode that limits it. */
const CREATION_REFUSED: Record<string, string> = {
  closed: "On this install, only an admin creates organizations. Ask one to create it or to invite you.",
  owners: "On this install, admins and organization owners create organizations. Ask one to create it or to invite you.",
};

/**
 * Null when this user may create an organization from the dashboard, or the reason they can't.
 * `organization_creation`: open is anyone signed in, owners is admins and owners of any
 * organization, closed is admins only.
 */
export async function organizationCreationRefusal(userId: string): Promise<string | null> {
  const [mode, user] = await Promise.all([
    readSetting("organization_creation"),
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { admin: true } }),
  ]);
  if (mode === "open" || user?.admin) return null;
  if (mode === "owners") {
    const [owned] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.role, ROLES.OWNER)))
      .limit(1);
    if (owned) return null;
  }
  return CREATION_REFUSED[mode] ?? CREATION_REFUSED.closed!;
}

const UNIQUE_VIOLATION = "23505";

/** Drizzle wraps driver errors, so the Postgres code sits on the cause. */
function isUniqueViolation(err: unknown): boolean {
  const candidates = [err, (err as { cause?: unknown } | null)?.cause];
  return candidates.some((candidate) => (candidate as { code?: string } | undefined)?.code === UNIQUE_VIOLATION);
}

/**
 * Thrown when the requested (or derived) slug is already taken. Its own class, not an ApiError:
 * each surface words it (`lib/api/errors.ts` holds the public API's taxonomy).
 */
export class SlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`Slug "${slug}" is taken. Choose another.`);
    this.name = "SlugTakenError";
  }
}

export interface CreatedOrganization {
  id: string;
  name: string;
  slug: string;
}

export async function readOrganization(organizationId: string): Promise<OrganizationSummary | null> {
  const [row] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      bodyRetentionDays: organizations.bodyRetentionDays,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row ?? null;
}

/**
 * Creates an organization and the creator's owner membership in one transaction — no
 * organization ever exists without its creator able to reach it (the load-bearing guarantee: a
 * failed membership write rolls the organization insert back with it). Who may call it is the
 * caller's check (`organizationCreationRefusal`). `scripts/seed.ts` and `lib/mail/system.ts`'s
 * system organization both insert directly, because both run before any user exists to hold a
 * membership.
 */
export async function createOrganization(input: CreateOrganizationRequest, creatorUserId: string): Promise<CreatedOrganization> {
  const slug = input.slug?.trim() || slugify(input.name) || newId("organization").replace("org_", "");

  try {
    return await db.transaction(async (tx) => {
      const organizationId = newId("organization");
      const [org] = await tx
        .insert(organizations)
        .values({ id: organizationId, name: input.name, slug })
        .returning({ id: organizations.id, name: organizations.name, slug: organizations.slug });
      if (!org) throw new Error("The organization couldn't be created.");

      await tx.insert(memberships).values({ id: newId("membership"), userId: creatorUserId, organizationId, role: ROLES.OWNER });
      return org;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new SlugTakenError(slug);
    throw err;
  }
}

/** This organization's owners. */
export async function listOwners(organizationId: string): Promise<OwnerSummary[]> {
  return db
    .select({ name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.role, ROLES.OWNER)));
}
