/**
 * #565: accepting an invitation while password sign-in is off creates the account with no
 * password and signs it in. The redeemed invitation is the credential.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, memberships, sessions, users } from "@/lib/db/schema";
import { adminActor } from "@/lib/activity/record";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { ROLES } from "@/lib/auth/permissions";
import { auth } from "@/lib/auth";
import { createAccountWithoutPassword, createAccountWithPassword } from "@/lib/auth/provisioning";
import { createInvitation } from "@/lib/invitations";
import { setSetting } from "@/lib/settings/values";
import { POST } from "@/app/api/auth/[...all]/route";
import { form, resetDatabase, seedFixture, seedSystemOrganization, type Fixture } from "./fixtures";

const cookieState = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (cookieState.store.has(name) ? { name, value: cookieState.store.get(name) } : undefined),
    set: (name: string, value: string) => {
      cookieState.store.set(name, value);
    },
    delete: (name: string) => {
      cookieState.store.delete(name);
    },
  }),
}));

const { acceptInvitationAction } = await import("../../app/(auth)/accept/actions");

const ADMIN = adminActor("usr_admin", "Admin");
const INVITED = "new-hire@example.net";
const PASSWORD = "correct horse battery staple";

let fixture: Fixture;

async function invite(): Promise<string> {
  const { token } = await createInvitation({ organizationId: fixture.organizationId, email: INVITED, role: ROLES.MEMBER, invitedBy: null });
  return token;
}

async function invitedUser() {
  const [user] = await db.select().from(users).where(eq(users.email, INVITED)).limit(1);
  return user;
}

async function hasPassword(userId: string): Promise<boolean> {
  const rows = await db.select().from(accounts).where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")));
  return rows.length > 0;
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  cookieState.store.clear();
  fixture = await seedFixture();
  await seedSystemOrganization();
  // System mail works, so sign-in links keep this admin a way in once passwords are off.
  await createAccountWithPassword({ email: "admin@example.net", name: "Admin", organizationId: fixture.organizationId, password: PASSWORD, emailVerified: true, admin: true });
});

describe("accepting an invitation", () => {
  it("asks for a password while password sign-in is on: the control", async () => {
    const state = await acceptInvitationAction({ status: "idle" }, form({ token: await invite(), name: "New Hire" }));

    expect(state).toMatchObject({ status: "error", field: "password" });
    expect(await invitedUser()).toBeUndefined();
  });

  it("sets the password it's given while password sign-in is on", async () => {
    const state = await acceptInvitationAction({ status: "idle" }, form({ token: await invite(), name: "New Hire", password: PASSWORD, confirm: PASSWORD }));

    expect(state.status).toBe("ok");
    expect(await hasPassword((await invitedUser())!.id)).toBe(true);
  });

  describe("while password sign-in is off", () => {
    beforeEach(async () => {
      await setSetting("sign_in_password", false, ADMIN);
    });

    it("creates the account with no password, joins it and signs it in", async () => {
      const state = await acceptInvitationAction({ status: "idle" }, form({ token: await invite(), name: "New Hire" }));

      expect(state.status).toBe("ok");
      const user = (await invitedUser())!;
      expect(await hasPassword(user.id)).toBe(false);
      expect(await db.select().from(memberships).where(eq(memberships.userId, user.id))).toHaveLength(1);
      expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(1);
    });

    it("sets the session cookie, which nextCookies hands to the browser", async () => {
      const user = await createAccountWithoutPassword({ email: INVITED, name: "New Hire", organizationId: fixture.organizationId, emailVerified: false });

      const { headers } = await auth.api.signInInvitedAccount({ body: { userId: user.id }, returnHeaders: true });

      expect(headers.get("set-cookie")).toContain("session_token");
    });

    it("ignores a password sent anyway", async () => {
      const state = await acceptInvitationAction({ status: "idle" }, form({ token: await invite(), name: "New Hire", password: PASSWORD, confirm: PASSWORD }));

      expect(state.status).toBe("ok");
      expect(await hasPassword((await invitedUser())!.id)).toBe(false);
    });

    it("refuses the app's own password sign-in too", async () => {
      await expect(auth.api.signInEmail({ body: { email: "admin@example.net", password: PASSWORD } })).rejects.toMatchObject({ body: { code: "SIGN_IN_METHOD_DISABLED" } });
    });
  });

  it("never serves the invitation sign-in over HTTP", async () => {
    const admin = await db.select().from(users).where(eq(users.email, "admin@example.net")).limit(1);
    const response = await POST(
      new Request("http://localhost:3100/api/auth/invitation/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3100" },
        body: JSON.stringify({ userId: admin[0]!.id }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });
});
