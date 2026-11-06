/**
 * Invitations: the only way an account is created on an install with public sign-up off. An
 * owner invites an address, mail carries a one-time token, and redeeming it creates the account
 * and the membership it names.
 */
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { invitations, memberships, organizations, users } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { isEmailAddress } from "@/lib/addresses";
import { createAccountWithoutPassword, createAccountWithPassword, createMembershipForNewUser } from "@/lib/auth/provisioning";
import { newId } from "@/lib/ids";
import { ROLES, type OrgRole } from "@/lib/auth/permissions";
import { SystemMailNotConfiguredError } from "@/lib/mail/system";
import { invitationLinkFor, sendInvitationMail } from "./mail";

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Lowercased whole, local part included, unlike a recipient address. An invitation names a
 * sign-in identity, and two accounts differing only in case is the wrong answer here.
 */
export function normalizeInvitedAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Invitations one organization may send per minute. */
function perOrganizationLimit(): number {
  return Number(process.env.INVITE_RATE_LIMIT ?? "10");
}

/** Invitations one address may be sent per minute, whoever sends them. */
function perEmailLimit(): number {
  return Number(process.env.INVITE_EMAIL_RATE_LIMIT ?? "3");
}

export interface InvitationRow {
  id: string;
  organizationId: string;
  email: string;
  role: OrgRole;
  token: string;
  status: string;
  expiresAt: Date;
}

/** `expired` is derived from the timestamp; the stored status is only ever pending, accepted or revoked. */
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface SerializedInvitation {
  id: string;
  email: string;
  role: OrgRole;
  status: InvitationStatus;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

export interface InvitationPage {
  data: SerializedInvitation[];
  next_cursor: string | null;
}

type Row = typeof invitations.$inferSelect;

function statusOf(row: Row, now: Date): InvitationStatus {
  if (row.status === "pending" && row.expiresAt <= now) return "expired";
  return row.status as InvitationStatus;
}

function serialize(row: Row, now: Date): SerializedInvitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role as OrgRole,
    status: statusOf(row, now),
    invited_by: row.invitedBy,
    expires_at: row.expiresAt.toISOString(),
    accepted_at: row.acceptedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

function tooMany(retryAfterMs: number): ApiError {
  const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new ApiError("rate_limit_exceeded", `Too many invitations. Retry after ${retryAfter} seconds.`, {
    headers: { "Retry-After": String(retryAfter) },
  });
}

/** Creates a pending invitation. The token is a one-time secret — hand it to the caller once. */
export async function createInvitation(options: {
  organizationId: string;
  email: string;
  role: OrgRole;
  invitedBy: string | null;
}): Promise<{ invitation: InvitationRow; token: string }> {
  const token = randomBytes(24).toString("base64url");
  const id = newId("invitation");
  const expiresAt = new Date((await dbNow()).getTime() + INVITATION_TTL_MS);

  const [row] = await db
    .insert(invitations)
    .values({
      id,
      organizationId: options.organizationId,
      email: normalizeInvitedAddress(options.email),
      role: options.role,
      token,
      invitedBy: options.invitedBy,
      status: "pending",
      expiresAt,
    })
    .returning();
  if (!row) throw new Error("The invitation couldn't be created.");

  return { invitation: row as InvitationRow, token };
}

async function organizationNamed(organizationId: string): Promise<string> {
  const [row] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!row) throw new ApiError("not_found", `No organization with id ${organizationId}.`);
  return row.name;
}

async function accountFor(email: string): Promise<{ id: string; name: string } | null> {
  const [row] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, email)).limit(1);
  return row ?? null;
}

/** Sends the mail and cleans up the row when it can't go out, so a pending invitation always reached someone. */
async function deliver(options: {
  invitationId: string;
  token: string;
  email: string;
  organizationName: string;
  invitedByName?: string;
  expiresAt: Date;
  hasAccount: boolean;
}): Promise<void> {
  try {
    await sendInvitationMail({
      to: options.email,
      organizationName: options.organizationName,
      invitedByName: options.invitedByName,
      link: invitationLinkFor(options.token),
      expiresAt: options.expiresAt,
      hasAccount: options.hasAccount,
    });
  } catch (error) {
    await db.delete(invitations).where(eq(invitations.id, options.invitationId));
    if (error instanceof SystemMailNotConfiguredError) {
      throw new ApiError("provider_unavailable", `The invitation wasn't sent, so nothing was created. ${error.message}`);
    }
    throw error;
  }
}

export interface InviteInput {
  email: string;
  role: OrgRole;
}

/**
 * Invites one address to one organization and mails the token. Refuses an address already in
 * the organization, and a second live invitation to the same address.
 */
export async function inviteToOrganization(
  organizationId: string,
  input: InviteInput,
  inviter: { userId: string | null; name?: string; actor: ActivityActor },
): Promise<SerializedInvitation> {
  const email = normalizeInvitedAddress(input.email);
  if (!isEmailAddress(email)) throw new ApiError("validation_failed", `"${input.email}" isn't an email address.`, { field: "email" });
  if (input.role !== ROLES.OWNER && input.role !== ROLES.MEMBER) {
    throw new ApiError("validation_failed", `Field "role" isn't valid.`, { field: "role" });
  }

  const organizationName = await organizationNamed(organizationId);

  const byOrganization = await consumeRateLimit(`invite:organization:${organizationId}`, perOrganizationLimit());
  if (byOrganization.exceeded) throw tooMany(byOrganization.retryAfterMs);
  const byEmail = await consumeRateLimit(`invite:email:${email}`, perEmailLimit());
  if (byEmail.exceeded) throw tooMany(byEmail.retryAfterMs);

  const account = await accountFor(email);
  if (account) {
    const [membership] = await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, account.id)))
      .limit(1);
    if (membership) throw new ApiError("validation_failed", `${email} is already in this organization.`, { field: "email" });
  }

  const now = await dbNow();
  const [live] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, organizationId),
        eq(invitations.email, email),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, now),
      ),
    )
    .limit(1);
  if (live) {
    throw new ApiError("validation_failed", `${email} already has an invitation to this organization. Resend or revoke that one.`, {
      field: "email",
    });
  }

  // An expired row holds the unique index, so it goes before the new one is written.
  await db
    .delete(invitations)
    .where(and(eq(invitations.organizationId, organizationId), eq(invitations.email, email), eq(invitations.status, "pending")));

  const { invitation, token } = await createInvitation({ organizationId, email, role: input.role, invitedBy: inviter.userId });

  await deliver({
    invitationId: invitation.id,
    token,
    email,
    organizationName,
    invitedByName: inviter.name,
    expiresAt: invitation.expiresAt,
    hasAccount: account !== null,
  });

  await recordActivity({
    organizationId,
    action: "member.invited",
    actor: inviter.actor,
    appliesTo: invitation.id,
    subjectLabel: email,
    metadata: { role: input.role },
  });

  return serialize(invitation as Row, now);
}

/** Rows past the cursor in `(created_at, id)` order, newest first. */
function afterInvitation(organizationId: string, cursor: string) {
  return sql`(${invitations.createdAt}, ${invitations.id}) < (select ${invitations.createdAt}, ${invitations.id} from ${invitations} where ${invitations.organizationId} = ${organizationId} and ${invitations.id} = ${cursor})`;
}

export async function listInvitations(
  organizationId: string,
  options: { limit: number; cursor?: string; status?: InvitationStatus },
): Promise<InvitationPage> {
  await organizationNamed(organizationId);
  const now = await dbNow();

  const stored =
    options.status === "expired"
      ? [and(eq(invitations.status, "pending"), lt(invitations.expiresAt, now))]
      : options.status === "pending"
        ? [and(eq(invitations.status, "pending"), gt(invitations.expiresAt, now))]
        : options.status
          ? [eq(invitations.status, options.status)]
          : [];

  const rows = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.organizationId, organizationId), ...stored, ...(options.cursor ? [afterInvitation(organizationId, options.cursor)] : [])))
    .orderBy(desc(invitations.createdAt), desc(invitations.id))
    .limit(options.limit + 1);

  const page = rows.slice(0, options.limit);
  return {
    data: page.map((row) => serialize(row, now)),
    next_cursor: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Pending and expired invitations, oldest first, for the Members screen. */
export async function listOpenInvitations(organizationId: string): Promise<SerializedInvitation[]> {
  const now = await dbNow();
  const rows = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.organizationId, organizationId), eq(invitations.status, "pending")))
    .orderBy(asc(invitations.createdAt), asc(invitations.id))
    .limit(200);
  return rows.map((row) => serialize(row, now));
}

async function readInvitation(organizationId: string, id: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.organizationId, organizationId), eq(invitations.id, id)))
    .limit(1);
  if (!row) throw new ApiError("not_found", `No invitation with id ${id} in this organization.`);
  return row;
}

/** Revokes a pending invitation. The token stops working immediately. */
export async function revokeInvitation(organizationId: string, id: string, actor: ActivityActor): Promise<SerializedInvitation> {
  const row = await readInvitation(organizationId, id);
  if (row.status !== "pending") {
    throw new ApiError("validation_failed", `That invitation was already ${row.status}.`, { field: "id" });
  }

  await db.update(invitations).set({ status: "revoked" }).where(eq(invitations.id, id));

  await recordActivity({
    organizationId,
    action: "member.invitation.revoked",
    actor,
    appliesTo: id,
    subjectLabel: row.email,
  });

  const now = await dbNow();
  return serialize({ ...row, status: "revoked" }, now);
}

/** Issues a new token, resets the expiry and mails it again. The old token stops working. */
export async function resendInvitation(
  organizationId: string,
  id: string,
  sender: { name?: string; actor: ActivityActor },
): Promise<SerializedInvitation> {
  const row = await readInvitation(organizationId, id);
  if (row.status !== "pending") {
    throw new ApiError("validation_failed", `That invitation was already ${row.status}. Invite the address again.`, { field: "id" });
  }

  const organizationName = await organizationNamed(organizationId);

  const byOrganization = await consumeRateLimit(`invite:organization:${organizationId}`, perOrganizationLimit());
  if (byOrganization.exceeded) throw tooMany(byOrganization.retryAfterMs);
  const byEmail = await consumeRateLimit(`invite:email:${row.email}`, perEmailLimit());
  if (byEmail.exceeded) throw tooMany(byEmail.retryAfterMs);

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date((await dbNow()).getTime() + INVITATION_TTL_MS);
  await db.update(invitations).set({ token, expiresAt }).where(eq(invitations.id, id));

  const account = await accountFor(row.email);
  try {
    await sendInvitationMail({
      to: row.email,
      organizationName,
      invitedByName: sender.name,
      link: invitationLinkFor(token),
      expiresAt,
      hasAccount: account !== null,
    });
  } catch (error) {
    if (error instanceof SystemMailNotConfiguredError) throw new ApiError("provider_unavailable", error.message);
    throw error;
  }

  await recordActivity({
    organizationId,
    action: "member.invitation.resent",
    actor: sender.actor,
    appliesTo: id,
    subjectLabel: row.email,
  });

  const now = await dbNow();
  return serialize({ ...row, token, expiresAt }, now);
}

/** What the accept screen shows before anyone commits to anything. */
export type InvitationPreview =
  | { state: "open"; email: string; organizationName: string; role: OrgRole; needsAccount: boolean; expiresAt: string }
  | { state: "expired"; expiresAt: string }
  | { state: "accepted" }
  | { state: "unknown" };

export async function previewInvitation(token: string): Promise<InvitationPreview> {
  const [row] = await db.select().from(invitations).where(eq(invitations.token, token)).limit(1);
  if (!row || row.status === "revoked") return { state: "unknown" };
  if (row.status === "accepted") return { state: "accepted" };

  const now = await dbNow();
  if (row.expiresAt <= now) return { state: "expired", expiresAt: row.expiresAt.toISOString() };

  const organizationName = await organizationNamed(row.organizationId);
  const account = await accountFor(row.email);
  return {
    state: "open",
    email: row.email,
    organizationName,
    role: row.role as OrgRole,
    needsAccount: account === null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

async function liveInvitation(token: string): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.token, token), eq(invitations.status, "pending"), gt(invitations.expiresAt, await dbNow())))
    .limit(1);
  return row ?? null;
}

async function accept(row: Row, userId: string): Promise<{ userId: string; organizationId: string }> {
  await createMembershipForNewUser(userId, row.organizationId, row.role as OrgRole);
  await db.update(invitations).set({ status: "accepted", acceptedAt: await dbNow() }).where(eq(invitations.id, row.id));

  await recordActivity({
    organizationId: row.organizationId,
    action: "member.joined",
    actor: { type: "user", id: userId, label: row.email },
    appliesTo: userId,
    metadata: { role: row.role },
  });

  return { userId, organizationId: row.organizationId };
}

/**
 * Redeems a pending, unexpired invitation for an address with no account: creates the account
 * through Better Auth's internal adapter and the membership the invitation names. Returns null
 * when the token is spent, expired or unknown, and refuses an address that already has an
 * account — that one accepts while signed in, so a token can't set a password on it.
 */
export async function redeemInvitation(
  token: string,
  name: string,
  password: string | null,
): Promise<{ userId: string; organizationId: string } | null> {
  const invitation = await liveInvitation(token);
  if (!invitation) return null;

  const existing = await accountFor(invitation.email);
  if (existing) throw new ApiError("validation_failed", "That address already has an account. Sign in, then open the link again.");

  const account = {
    email: invitation.email,
    name: name || invitation.email.split("@")[0] || "User",
    organizationId: invitation.organizationId,
    emailVerified: false,
  };
  // Null while password sign-in is off: the account signs in by link or passkey instead.
  const created = password === null ? await createAccountWithoutPassword(account) : await createAccountWithPassword({ ...account, password });

  return accept(invitation, created.id);
}

/**
 * Accepts an invitation as the signed-in account. The session's address has to be the invited
 * one, so a token can't add a stranger's account to the organization.
 */
export async function acceptInvitationAs(
  token: string,
  user: { id: string; email: string },
): Promise<{ userId: string; organizationId: string } | null> {
  const invitation = await liveInvitation(token);
  if (!invitation) return null;
  if (normalizeInvitedAddress(user.email) !== invitation.email) {
    throw new ApiError("validation_failed", `This invitation is for ${invitation.email}. Sign out and open the link again.`);
  }
  return accept(invitation, user.id);
}
