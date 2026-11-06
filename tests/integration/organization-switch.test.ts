/**
 * #164, #380: the org switcher. `listReachableOrganizations` is what the switcher's options
 * come from, and `resolveDashboardSession`'s chosen-org argument is what a persisted choice
 * goes through. Neither may trust a client-supplied id — the load-bearing case here is a member
 * of one organization who has the persisted choice pointed at an organization they don't belong
 * to. That must fall back to their own organization, not honor the tampered value and not
 * throw.
 *
 * The admin flag reaches nothing on its own: an admin's switcher is their memberships, and an
 * organization they don't belong to is reachable only through an emulation ticket.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { memberships, users } from "@/lib/db/schema";
import { listReachableOrganizations, resolveDashboardSession, sessionActor } from "@/lib/dashboard/session";
import { parseEmulationTicket, type EmulationTicket } from "@/lib/dashboard/emulation";
import { ROLES } from "@/lib/auth/permissions";
import { newId } from "@/lib/ids";
import { memberOf, resetDatabase, seedFixture, type Fixture } from "./fixtures";

async function operatorWithNoMembership(): Promise<string> {
  const userId = crypto.randomUUID();
  // The legacy users.organization_id column is non-null, so an admin still needs some
  // organization row to satisfy it even with no membership row.
  const anchor = await seedFixture();
  await db.insert(users).values({
    id: userId,
    organizationId: anchor.organizationId,
    name: "Admin",
    email: `${userId}@example.com`,
    admin: true,
  });
  return userId;
}

let orgA: Fixture;
let orgB: Fixture;

beforeEach(async () => {
  await resetDatabase();
  orgA = await seedFixture();
  orgB = await seedFixture();
});

describe("listReachableOrganizations", () => {
  it("a non-admin sees only their own memberships", async () => {
    const userId = await memberOf(orgA.organizationId);

    const reachable = await listReachableOrganizations(userId);

    expect(reachable.map((org) => org.id)).toEqual([orgA.organizationId]);
    expect(reachable[0]?.role).toBe(ROLES.MEMBER);
  });

  it("a non-admin who belongs to two organizations sees both, and nothing else", async () => {
    const userId = await memberOf(orgA.organizationId, ROLES.OWNER);
    await db.insert(memberships).values({ id: newId("membership"), userId, organizationId: orgB.organizationId, role: ROLES.MEMBER });

    const reachable = await listReachableOrganizations(userId);

    expect(new Set(reachable.map((org) => org.id))).toEqual(new Set([orgA.organizationId, orgB.organizationId]));
  });

  it("an admin sees their memberships and nothing else", async () => {
    const userId = await memberOf(orgA.organizationId, ROLES.OWNER, true);

    const reachable = await listReachableOrganizations(userId);

    expect(reachable.map((org) => org.id)).toEqual([orgA.organizationId]);
    expect(reachable[0]?.role).toBe(ROLES.OWNER);
  });

  it("an admin with no membership has nothing to switch to", async () => {
    const userId = await operatorWithNoMembership();

    expect(await listReachableOrganizations(userId)).toEqual([]);
  });
});

describe("resolveDashboardSession: choosing an organization", () => {
  it("honors a chosen organization the user is a member of", async () => {
    const userId = await memberOf(orgA.organizationId, ROLES.OWNER);
    await db.insert(memberships).values({ id: newId("membership"), userId, organizationId: orgB.organizationId, role: ROLES.MEMBER });

    const session = await resolveDashboardSession(userId, { name: "Test", email: `${userId}@example.com`, admin: false }, orgB.organizationId);

    expect(session?.organizationId).toBe(orgB.organizationId);
    expect(session?.role).toBe(ROLES.MEMBER);
  });

  it("THE LOAD-BEARING CASE: a chosen organization the user cannot reach is refused and falls back to their own, not honored", async () => {
    const userId = await memberOf(orgA.organizationId, ROLES.MEMBER);

    const session = await resolveDashboardSession(userId, { name: "Test", email: `${userId}@example.com`, admin: false }, orgB.organizationId);

    expect(session?.organizationId).toBe(orgA.organizationId);
    expect(session?.organizationId).not.toBe(orgB.organizationId);
  });

  it("THE OTHER LOAD-BEARING CASE: an admin's chosen organization outside their memberships is refused, not honored", async () => {
    const userId = await memberOf(orgA.organizationId, ROLES.OWNER, true);

    const session = await resolveDashboardSession(userId, { name: "Admin", email: `${userId}@example.com`, admin: true }, orgB.organizationId);

    expect(session?.organizationId).toBe(orgA.organizationId);
    expect(session?.emulating).toBeNull();
  });

  it("falls back to the current behavior (a membership) when nothing is chosen", async () => {
    const userId = await memberOf(orgA.organizationId, ROLES.OWNER);

    const session = await resolveDashboardSession(userId, { name: "Test", email: `${userId}@example.com`, admin: false });

    expect(session?.organizationId).toBe(orgA.organizationId);
  });

  it("an admin with no membership row resolves to nothing, rather than to somebody else's organization", async () => {
    const userId = await operatorWithNoMembership();

    const session = await resolveDashboardSession(userId, { name: "Admin", email: `${userId}@example.com`, admin: true }, orgA.organizationId);

    expect(session).toBeNull();
  });
});

function ticket(organizationId: string, minutes = 30): EmulationTicket {
  return { organizationId, expiresAt: new Date(Date.now() + minutes * 60_000) };
}

describe("resolveDashboardSession: emulation", () => {
  it("puts an admin in the organization the ticket names, as an owner, marked as emulating", async () => {
    const userId = await memberOf(orgA.organizationId, ROLES.OWNER, true);

    const session = await resolveDashboardSession(
      userId,
      { name: "Admin", email: `${userId}@example.com`, admin: true },
      orgA.organizationId,
      ticket(orgB.organizationId),
    );

    expect(session?.organizationId).toBe(orgB.organizationId);
    expect(session?.role).toBe(ROLES.OWNER);
    expect(session?.emulating).not.toBeNull();
  });

  it("refuses a ticket from someone who isn't an admin", async () => {
    const userId = await memberOf(orgA.organizationId, ROLES.OWNER);

    const session = await resolveDashboardSession(
      userId,
      { name: "Test", email: `${userId}@example.com`, admin: false },
      null,
      ticket(orgB.organizationId),
    );

    expect(session?.organizationId).toBe(orgA.organizationId);
    expect(session?.emulating).toBeNull();
  });

  it("refuses a ticket naming an organization that's gone, and falls back to a membership", async () => {
    const userId = await memberOf(orgA.organizationId, ROLES.OWNER, true);

    const session = await resolveDashboardSession(
      userId,
      { name: "Admin", email: `${userId}@example.com`, admin: true },
      null,
      ticket("org_missing"),
    );

    expect(session?.organizationId).toBe(orgA.organizationId);
    expect(session?.emulating).toBeNull();
  });

  it("ignores a ticket for an organization the admin belongs to — that's a switch, and the role is the real one", async () => {
    const userId = await memberOf(orgA.organizationId, ROLES.MEMBER, true);

    const session = await resolveDashboardSession(
      userId,
      { name: "Admin", email: `${userId}@example.com`, admin: true },
      orgA.organizationId,
      ticket(orgA.organizationId),
    );

    expect(session?.organizationId).toBe(orgA.organizationId);
    expect(session?.role).toBe(ROLES.MEMBER);
    expect(session?.emulating).toBeNull();
  });
});

describe("sessionActor", () => {
  it("records an emulated write as the admin, not as a member", async () => {
    const userId = await memberOf(orgA.organizationId, ROLES.OWNER, true);
    const session = await resolveDashboardSession(
      userId,
      { name: "Admin", email: `${userId}@example.com`, admin: true },
      null,
      ticket(orgB.organizationId),
    );

    expect(sessionActor(session!)).toMatchObject({ type: "admin", id: userId });
  });

  it("records a member's own write as theirs", async () => {
    const userId = await memberOf(orgA.organizationId, ROLES.MEMBER);
    const session = await resolveDashboardSession(userId, { name: "Test", email: `${userId}@example.com`, admin: false });

    expect(sessionActor(session!)).toMatchObject({ type: "user", id: userId });
  });
});

describe("parseEmulationTicket", () => {
  it("reads an organization and an expiry", () => {
    const expires = Date.now() + 60_000;

    expect(parseEmulationTicket(`org_123:${expires}`)).toEqual({ organizationId: "org_123", expiresAt: new Date(expires) });
  });

  it("refuses an expired ticket, so a forgotten tab stops acting on its own", () => {
    expect(parseEmulationTicket(`org_123:${Date.now() - 1}`)).toBeNull();
  });

  it("refuses anything malformed", () => {
    expect(parseEmulationTicket("")).toBeNull();
    expect(parseEmulationTicket("org_123")).toBeNull();
    expect(parseEmulationTicket(":123")).toBeNull();
    expect(parseEmulationTicket("org_123:soon")).toBeNull();
  });
});
