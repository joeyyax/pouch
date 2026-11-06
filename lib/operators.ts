/**
 * Accounts an operator manages: the service-wide admin flag and account deletion, defined once
 * for `/v1/admin/users`, its MCP tools and the Admins screen. The rules themselves live in
 * `lib/auth/admin.ts` — the last admin can't be demoted or deleted, and either one revokes the
 * admin keys that account created.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, organizations, users } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { LastOwnerError } from "@/lib/memberships";
import { keysetBefore } from "@/lib/db/keyset";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import type { OrgRole } from "@/lib/auth/permissions";
import { deleteUserAccount, LastAdminError, setAdmin } from "@/lib/auth/admin";

export interface OperatorMembership {
  organization_id: string;
  organization_name: string;
  role: OrgRole;
}

export interface SerializedOperator {
  id: string;
  name: string;
  email: string;
  admin: boolean;
  memberships: OperatorMembership[];
  created_at: string;
}

export interface OperatorPage {
  data: SerializedOperator[];
  next_cursor: string | null;
}

type UserRow = typeof users.$inferSelect;

/** Memberships for a page of accounts, in one query rather than one per row. */
async function membershipsFor(userIds: string[]): Promise<Map<string, OperatorMembership[]>> {
  const grouped = new Map<string, OperatorMembership[]>();
  if (userIds.length === 0) return grouped;

  const rows = await db
    .select({
      userId: memberships.userId,
      organizationId: memberships.organizationId,
      organizationName: organizations.name,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(inArray(memberships.userId, userIds))
    .orderBy(memberships.createdAt);

  for (const row of rows) {
    const list = grouped.get(row.userId) ?? [];
    list.push({ organization_id: row.organizationId, organization_name: row.organizationName, role: row.role });
    grouped.set(row.userId, list);
  }
  return grouped;
}

function serialize(row: UserRow, membershipRows: OperatorMembership[]): SerializedOperator {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    admin: row.admin,
    memberships: membershipRows,
    created_at: row.createdAt.toISOString(),
  };
}

export async function listOperatorAccounts(options: {
  limit: number;
  cursor?: string;
  admin?: "true" | "false";
  email?: string;
  memberships?: boolean;
}): Promise<OperatorPage> {
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        ...(options.admin ? [eq(users.admin, options.admin === "true")] : []),
        ...(options.email ? [eq(users.email, options.email.toLowerCase())] : []),
        ...(options.cursor ? [keysetBefore({ table: users, sort: users.createdAt, id: users.id }, options.cursor)] : []),
      ),
    )
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(options.limit + 1);

  const page = rows.slice(0, options.limit);
  const grouped = options.memberships === false ? new Map<string, OperatorMembership[]>() : await membershipsFor(page.map((row) => row.id));
  return {
    data: page.map((row) => serialize(row, grouped.get(row.id) ?? [])),
    next_cursor: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

async function accountRow(id: string): Promise<UserRow> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw new ApiError("not_found", `No account with id ${id}.`);
  return row;
}

/** Without `memberships`, that read is skipped and the list reads empty; a caller projects it away. */
export async function readOperatorAccount(id: string, options: { memberships?: boolean } = {}): Promise<SerializedOperator> {
  const row = await accountRow(id);
  if (options.memberships === false) return serialize(row, []);
  return serialize(row, (await membershipsFor([row.id])).get(row.id) ?? []);
}

/** The last-admin and last-owner refusals, as the API's own error rather than a library class. */
function refusal(error: unknown): unknown {
  if (error instanceof LastAdminError) return new ApiError("validation_failed", error.message, { field: "admin" });
  if (error instanceof LastOwnerError) return new ApiError("validation_failed", error.message, { field: "id" });
  return error;
}

/** Grants or revokes service-wide admin. Revoking also revokes the admin keys this account created. */
export async function setOperatorAdmin(id: string, admin: boolean, actor: ActivityActor): Promise<SerializedOperator> {
  const before = await accountRow(id);
  if (before.admin !== admin) {
    try {
      await setAdmin(id, admin);
    } catch (error) {
      throw refusal(error);
    }
    await recordActivity({
      organizationId: null,
      action: admin ? "admin.granted" : "admin.revoked",
      actor,
      appliesTo: id,
      subjectLabel: before.name,
      metadata: { email: before.email },
    });
  }
  return readOperatorAccount(id);
}

export interface DeletedAccount {
  id: string;
  email: string;
  deleted: true;
}

/**
 * Deletes an account. Its memberships go with it and the admin keys it created are revoked.
 * Organization keys it minted keep working — they carry the organization's authority, not a
 * person's (see docs/decisions.md).
 */
export async function deleteOperatorAccount(id: string, actor: ActivityActor): Promise<DeletedAccount> {
  const row = await accountRow(id);
  try {
    await deleteUserAccount(id);
  } catch (error) {
    throw refusal(error);
  }

  await recordActivity({
    organizationId: null,
    action: "account.deleted",
    actor,
    appliesTo: id,
    subjectLabel: row.name,
    metadata: { email: row.email },
  });
  return { id, email: row.email, deleted: true };
}
