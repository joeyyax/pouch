import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, organizations } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/admin";
import { canWriteInOrganization, isOrgOwner, ROLES, type OrgRole } from "@/lib/auth/permissions";
import { adminActor, userActor } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { readEmulationTicket, type EmulationTicket } from "./emulation";
import { ApiError } from "@/lib/api/errors";
import { zoneOrUtc } from "@/lib/time-zone";

/** Where the acting organization choice is persisted. Read in server components, written only
 * by `switchOrganizationAction` and `createOrganizationAction` (via `setActiveOrganization`). */
export const ACTIVE_ORGANIZATION_COOKIE = "pouch_active_organization";

/** Persists the acting organization choice. Callers are responsible for having already
 * checked the id is one the caller may reach — this only writes the cookie. */
export async function setActiveOrganization(organizationId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORGANIZATION_COOKIE, organizationId, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

export interface DashboardSession {
  /** Every dashboard query is scoped by this. Resolved through `memberships`, never `users.organization_id`. */
  organizationId: string;
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  /** Service-wide access to Pouch's own admin. Orthogonal to `role`. */
  admin: boolean;
  /** The IANA zone dates are shown in. */
  timeZone: string;
  /** Set while an admin is visiting an organization they hold no membership in. */
  emulating: { expiresAt: Date } | null;
}

/** One organization the switcher can offer. Always a membership, so always a role. */
export interface ReachableOrganization {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
}

/**
 * The organizations a user may act as: their memberships, admin or not. Never anything the
 * client supplies — this is the one place that decides what a chosen organization id is allowed
 * to be, so both `resolveDashboardSession` and the switcher's own list go through it. An admin
 * reaches an organization they don't belong to by emulating it, which is a separate ticket
 * (`lib/dashboard/emulation.ts`) and never a switcher option.
 */
export async function listReachableOrganizations(userId: string): Promise<ReachableOrganization[]> {
  const userMemberships = await db
    .select({ organizationId: memberships.organizationId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(memberships.createdAt);
  const roleByOrganization = new Map(userMemberships.map((row) => [row.organizationId, row.role as OrgRole]));
  if (userMemberships.length === 0) return [];

  const rows = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(
      inArray(
        organizations.id,
        userMemberships.map((m) => m.organizationId),
      ),
    );
  // Order follows membership, oldest first, not the arbitrary row order `inArray` returns.
  const byId = new Map(rows.map((row) => [row.id, row]));
  return userMemberships
    .map((m) => byId.get(m.organizationId))
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map((row) => ({ ...row, role: roleByOrganization.get(row.id) ?? ROLES.MEMBER }));
}

/** The organization an emulation ticket names, when it still exists. */
async function emulatedOrganization(organizationId: string): Promise<{ id: string } | null> {
  const [row] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  return row ?? null;
}

/**
 * Resolves the acting organization for a signed-in user. `chosenOrganizationId` is whatever
 * the caller has persisted (a cookie) — it's honored only when `listReachableOrganizations`
 * says the user can reach it; otherwise it's refused and this falls back to a membership, the
 * same as if nothing had been chosen. Returns null when there's nothing reachable at all,
 * which the caller turns into a redirect rather than an unscoped query.
 */
export async function resolveDashboardSession(
  userId: string,
  user: { name?: string | null; email: string; admin?: boolean | null; timeZone?: string | null },
  chosenOrganizationId?: string | null,
  emulation?: EmulationTicket | null,
): Promise<DashboardSession | null> {
  const admin = Boolean(user.admin);
  const reachable = await listReachableOrganizations(userId);
  const name = user.name || user.email;
  const timeZone = zoneOrUtc(user.timeZone);

  // An emulation ticket outranks the persisted choice: it was entered deliberately and it's
  // the state the banner is showing. It's honored only for an admin, only for an organization
  // that still exists, and only where there's no membership — a member switches instead.
  if (admin && emulation && !reachable.some((org) => org.id === emulation.organizationId)) {
    const organization = await emulatedOrganization(emulation.organizationId);
    if (organization) {
      return {
        organizationId: organization.id,
        userId,
        name,
        email: user.email,
        // Support reproduces what a customer sees, and an owner sees all of it.
        role: ROLES.OWNER,
        admin,
        timeZone,
        emulating: { expiresAt: emulation.expiresAt },
      };
    }
  }

  if (reachable.length === 0) return null;

  const chosen = chosenOrganizationId ? reachable.find((org) => org.id === chosenOrganizationId) : undefined;
  const active = chosen ?? reachable[0]!;

  return {
    organizationId: active.id,
    userId,
    name,
    email: user.email,
    role: active.role,
    admin,
    timeZone,
    emulating: null,
  };
}

/**
 * Who an activity row names for a dashboard write. An admin's writes inside an organization
 * they're emulating are recorded as the admin they are, so the feed never reads as a member's.
 */
export function sessionActor(session: DashboardSession): ActivityActor {
  return session.emulating ? adminActor(session.userId, session.name) : userActor(session.userId, session.name);
}

/** The signed-in person, and the organization they're acting in when there is one. */
export interface ChromeSession {
  userId: string;
  name: string;
  email: string;
  admin: boolean;
  /** The IANA zone dates are shown in. */
  timeZone: string;
  /** Null for an admin who belongs to no organization: the admin screens are all they reach. */
  organization: DashboardSession | null;
}

/**
 * What the dashboard frame renders around. An admin with no membership and no emulation has no
 * acting organization — they get the frame and the admin screens, not a stand-in organization
 * somebody else owns. Anyone else with nothing reachable goes to `/start` to create one.
 */
export async function requireChromeSession(): Promise<ChromeSession> {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");

  const user = session.user as { name?: string; email: string; admin?: boolean; timeZone?: string | null };
  const cookieStore = await cookies();
  const ticket = await readEmulationTicket();
  // A ticket is checked against the database rather than the session's copy of the flag, so a
  // demoted admin stops emulating on their next request instead of at their next sign-in.
  const admin = ticket ? await isAdmin(session.user.id) : Boolean(user.admin);
  const resolved = await resolveDashboardSession(
    session.user.id,
    { ...user, admin },
    cookieStore.get(ACTIVE_ORGANIZATION_COOKIE)?.value ?? null,
    ticket,
  );
  if (!resolved && !admin) redirect("/start");

  return {
    userId: session.user.id,
    name: user.name || user.email,
    email: user.email,
    admin,
    timeZone: zoneOrUtc(user.timeZone),
    organization: resolved,
  };
}

/**
 * The signed-in user and the organization every dashboard query is scoped by. Nothing reachable
 * sends them somewhere they can act rather than falling through to an unscoped query — a person
 * whose last organization was deleted has an account and nowhere to work, and an admin without
 * one has the organizations list.
 */
export async function requireOrganization(): Promise<DashboardSession> {
  const chrome = await requireChromeSession();
  if (!chrome.organization) redirect(chrome.admin ? "/admin/settings/organizations" : "/start");
  return chrome.organization;
}

/**
 * The one refusal a role check produces, everywhere. `action` names what was refused, in the
 * imperative ("rotate these credentials"), so the message reads as one sentence — see
 * docs/product/voice.md. `detail` adds a second sentence when the reason isn't obvious from
 * the action alone. An `ApiError` rather than a dashboard-only class so the server actions,
 * the dashboard routes and the error envelope all carry one code — `insufficient_role`, in
 * docs/api/conventions.md.
 */
function refuse(reason: string, action: string, detail?: string): ApiError {
  return new ApiError("insufficient_role", `${reason} ${action}.${detail ? ` ${detail}` : ""}`);
}

/**
 * `requireOrganization`, then requires owner. Owner-only is people management, organization
 * settings and deleting the organization — see docs/decisions.md.
 */
export async function requireOrganizationOwner(action: string, detail?: string): Promise<DashboardSession> {
  const session = await requireOrganization();
  if (!isOrgOwner(session.role)) throw refuse("You need to be an owner to", action, detail);
  return session;
}

/**
 * `requireOrganization` for a write. Every write inside an organization comes through here — a
 * server action, a dashboard route, an export, a test send — so the list of write paths is the
 * list of callers, and a read-only role would need no other change to hold.
 *
 * Both current roles pass it, so today it refuses nothing a session can actually carry. It's
 * kept for that inventory and for where the next role plugs in, not as a live gate.
 */
export async function requireOrganizationWrite(action: string, detail?: string): Promise<DashboardSession> {
  const session = await requireOrganization();
  if (!canWriteInOrganization(session.role)) throw refuse("Your role doesn't let you", action, detail);
  return session;
}
