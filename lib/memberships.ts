/**
 * Who is in an organization and what they may do there, defined once for
 * `/v1/admin/organizations/:id/members`, its MCP tools and the Settings screen's Members
 * section. Adding someone is invitation work (`lib/invitations.ts`) and isn't here.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { memberships, organizations, users } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { ROLES, type OrgRole } from "@/lib/auth/permissions";

/** Thrown when the change would leave an organization with nobody to own it. */
export class LastOwnerError extends Error {
  constructor() {
    super("This is the only owner. Make someone else an owner first.");
    this.name = "LastOwnerError";
  }
}

export interface SerializedMember {
  user_id: string;
  name: string;
  email: string;
  role: OrgRole;
  admin: boolean;
  created_at: string;
}

export interface MemberPage {
  data: SerializedMember[];
  next_cursor: string | null;
}

export async function assertOrganizationExists(organizationId: string): Promise<void> {
  const [row] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!row) throw new ApiError("not_found", `No organization with id ${organizationId}.`);
}

/**
 * Rows past the cursor member in `(created_at, user_id)` order, within one organization. The
 * cursor's timestamp is read in SQL, since a JS Date drops the microseconds rows written in one
 * transaction share.
 */
function afterMember(organizationId: string, cursor: string) {
  return sql`(${memberships.createdAt}, ${memberships.userId}) > (select ${memberships.createdAt}, ${memberships.userId} from ${memberships} where ${memberships.organizationId} = ${organizationId} and ${memberships.userId} = ${cursor})`;
}

/** Members oldest first, so the owner who created the organization leads the list. */
export async function listMembers(organizationId: string, options: { limit: number; cursor?: string }): Promise<MemberPage> {
  await assertOrganizationExists(organizationId);

  const rows = await db
    .select({
      userId: memberships.userId,
      name: users.name,
      email: users.email,
      role: memberships.role,
      admin: users.admin,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        ...(options.cursor ? [afterMember(organizationId, options.cursor)] : []),
      ),
    )
    .orderBy(asc(memberships.createdAt), asc(memberships.userId))
    .limit(options.limit + 1);

  const page = rows.slice(0, options.limit);
  return {
    data: page.map((row) => ({
      user_id: row.userId,
      name: row.name,
      email: row.email,
      role: row.role,
      admin: row.admin,
      created_at: row.createdAt.toISOString(),
    })),
    next_cursor: rows.length > options.limit ? (page.at(-1)?.userId ?? null) : null,
  };
}

/**
 * Changes one person's role in one organization. Locks the organization's membership rows, so
 * two concurrent demotions can't both pass the last-owner check.
 */
/**
 * Throws `LastOwnerError` if deleting `userId` would leave any organization with no owner.
 * Deleting an account cascades its memberships, so the guard that protects a removal has to
 * cover a deletion too, or the organization is left with nobody who can manage it.
 */
export async function assertOwnerRemovable(userId: string, executor: Executor = db): Promise<void> {
  const owned = await executor
    .select({ organizationId: memberships.organizationId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.role, ROLES.OWNER)))
    .for("update");
  if (owned.length === 0) return;

  const others = await executor
    .select({ organizationId: memberships.organizationId, userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        inArray(memberships.organizationId, owned.map((row) => row.organizationId)),
        eq(memberships.role, ROLES.OWNER),
      ),
    );
  const covered = new Set(others.filter((row) => row.userId !== userId).map((row) => row.organizationId));
  if (owned.some((row) => !covered.has(row.organizationId))) throw new LastOwnerError();
}

export async function setMembershipRole(organizationId: string, userId: string, role: OrgRole): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.organizationId, organizationId))
      .for("update");

    const current = rows.find((row) => row.userId === userId);
    if (!current) throw new ApiError("not_found", "That person isn't in this organization.");
    if (current.role === role) return;

    const losesLastOwner =
      current.role === ROLES.OWNER && role !== ROLES.OWNER && !rows.some((row) => row.userId !== userId && row.role === ROLES.OWNER);
    if (losesLastOwner) throw new LastOwnerError();

    await tx
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId)));
  });
}

async function memberRow(organizationId: string, userId: string): Promise<SerializedMember> {
  const [row] = await db
    .select({
      userId: memberships.userId,
      name: users.name,
      email: users.email,
      role: memberships.role,
      admin: users.admin,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId)))
    .limit(1);
  if (!row) {
    await assertOrganizationExists(organizationId);
    throw new ApiError("not_found", "That person isn't in this organization.");
  }
  return {
    user_id: row.userId,
    name: row.name,
    email: row.email,
    role: row.role,
    admin: row.admin,
    created_at: row.createdAt.toISOString(),
  };
}

/** The refusal an API caller gets when the change would leave the organization ownerless. */
function refusal(error: unknown): unknown {
  return error instanceof LastOwnerError ? new ApiError("validation_failed", error.message, { field: "role" }) : error;
}

export async function updateMemberRole(
  organizationId: string,
  userId: string,
  role: OrgRole,
  actor: ActivityActor,
): Promise<SerializedMember> {
  const before = await memberRow(organizationId, userId);
  try {
    await setMembershipRole(organizationId, userId, role);
  } catch (error) {
    throw refusal(error);
  }

  if (before.role !== role) {
    await recordActivity({
      organizationId,
      action: "member.role.changed",
      actor,
      appliesTo: userId,
      subjectLabel: before.name,
      metadata: { from: before.role, to: role },
    });
  }
  return memberRow(organizationId, userId);
}

export interface RemovedMember {
  user_id: string;
  organization_id: string;
  removed: true;
}

/**
 * Removes someone from an organization. Their account and the keys they created stay — an
 * organization key carries the organization's authority, not a person's (see docs/decisions.md).
 * The last owner can't be removed.
 */
export async function removeMember(organizationId: string, userId: string, actor: ActivityActor): Promise<RemovedMember> {
  const member = await memberRow(organizationId, userId);

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.organizationId, organizationId))
      .for("update");

    const current = rows.find((row) => row.userId === userId);
    if (!current) throw new ApiError("not_found", "That person isn't in this organization.");
    if (current.role === ROLES.OWNER && !rows.some((row) => row.userId !== userId && row.role === ROLES.OWNER)) {
      throw new ApiError("validation_failed", new LastOwnerError().message, { field: "user_id" });
    }

    await tx.delete(memberships).where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId)));
  });

  await recordActivity({
    organizationId,
    action: "member.removed",
    actor,
    appliesTo: userId,
    subjectLabel: member.name,
    metadata: { role: member.role },
  });
  return { user_id: userId, organization_id: organizationId, removed: true };
}
