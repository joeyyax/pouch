import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { invitations, memberships, users } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import {
  acceptInvitationAs,
  createInvitation,
  inviteToOrganization,
  listOpenInvitations,
  previewInvitation,
  redeemInvitation,
  resendInvitation,
  revokeInvitation,
} from "@/lib/invitations";
import { invitationMailText } from "@/lib/invitations/mail";
import { ROLES } from "@/lib/auth/permissions";
import { userActor } from "@/lib/activity/record";
import { disableSystemMail, resetDatabase, seedFixture, seedSystemOrganization, systemMailMessages, type Fixture } from "./fixtures";

let fixture: Fixture;
let inviterId: string;

const PASSWORD = "correct horse battery staple";

function inviter() {
  return { userId: inviterId, name: "Inviter", actor: userActor(inviterId, "Inviter") };
}

async function seedAccount(email: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, organizationId: fixture.organizationId, name: "Existing", email });
  return id;
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture();
  await seedSystemOrganization();
  inviterId = crypto.randomUUID();
  await db.insert(users).values({
    id: inviterId,
    organizationId: fixture.organizationId,
    name: "Inviter",
    email: `${inviterId}@example.com`,
    admin: true,
  });
});

describe("inviteToOrganization", () => {
  it("creates a pending invitation and mails the link", async () => {
    const invitation = await inviteToOrganization(fixture.organizationId, { email: "New-Hire@Client.Example", role: ROLES.MEMBER }, inviter());

    expect(invitation.status).toBe("pending");
    expect(invitation.email).toBe("new-hire@client.example");
    expect(invitation.role).toBe(ROLES.MEMBER);

    const sent = await systemMailMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.recipients).toContain("new-hire@client.example");
    expect(sent[0]?.subject).toBe("Test invited you to Pouch");
  });

  it("refuses a second live invitation to the same address", async () => {
    await inviteToOrganization(fixture.organizationId, { email: "ada@example.com", role: ROLES.MEMBER }, inviter());

    await expect(inviteToOrganization(fixture.organizationId, { email: "ada@example.com", role: ROLES.OWNER }, inviter())).rejects.toThrow(
      /already has an invitation/,
    );
    expect(await listOpenInvitations(fixture.organizationId)).toHaveLength(1);
  });

  it("refuses an address already in the organization", async () => {
    const userId = await seedAccount("member@example.com");
    await db.insert(memberships).values({ id: crypto.randomUUID(), userId, organizationId: fixture.organizationId, role: ROLES.MEMBER });

    await expect(inviteToOrganization(fixture.organizationId, { email: "member@example.com", role: ROLES.MEMBER }, inviter())).rejects.toThrow(
      /already in this organization/,
    );
  });

  it("refuses an address that isn't an address", async () => {
    await expect(inviteToOrganization(fixture.organizationId, { email: "not-an-address", role: ROLES.MEMBER }, inviter())).rejects.toThrow(
      /isn't an email address/,
    );
  });

  it("creates nothing when system mail isn't set up", async () => {
    await disableSystemMail();

    await expect(
      inviteToOrganization(fixture.organizationId, { email: "ada@example.com", role: ROLES.MEMBER }, inviter()),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(await listOpenInvitations(fixture.organizationId)).toHaveLength(0);
  });

  it("stops at the per-address limit", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const invitation = await inviteToOrganization(fixture.organizationId, { email: "ada@example.com", role: ROLES.MEMBER }, inviter());
      await revokeInvitation(fixture.organizationId, invitation.id, inviter().actor);
    }

    await expect(inviteToOrganization(fixture.organizationId, { email: "ada@example.com", role: ROLES.MEMBER }, inviter())).rejects.toMatchObject(
      { code: "rate_limit_exceeded" },
    );
  });
});

describe("the invitation email", () => {
  it("tells someone with no account to set a password, and someone with one to sign in", () => {
    const base = {
      to: "ada@example.com",
      organizationName: "Test",
      invitedByName: "Inviter",
      link: "https://mail.example/accept?token=abc",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };

    expect(invitationMailText({ ...base, hasAccount: false })).toContain("set a password");
    expect(invitationMailText({ ...base, hasAccount: true })).toContain("sign in to join");
    expect(invitationMailText({ ...base, hasAccount: false })).toContain("expires in 7 days");
  });
});

describe("redeemInvitation", () => {
  it("creates the account and a membership with the invited role", async () => {
    const { token } = await createInvitation({
      organizationId: fixture.organizationId,
      email: "new-hire@client.example",
      role: ROLES.MEMBER,
      invitedBy: inviterId,
    });

    const result = await redeemInvitation(token, "New Hire", PASSWORD);
    expect(result).not.toBeNull();
    expect(result!.organizationId).toBe(fixture.organizationId);

    const [membership] = await db.select().from(memberships).where(eq(memberships.userId, result!.userId)).limit(1);
    expect(membership?.organizationId).toBe(fixture.organizationId);
    expect(membership?.role).toBe(ROLES.MEMBER);

    const [invitation] = await db.select().from(invitations).where(eq(invitations.token, token)).limit(1);
    expect(invitation?.status).toBe("accepted");

    // The redeemed invitee is not an admin — org-scoped access, not service-wide.
    const [user] = await db.select().from(users).where(eq(users.id, result!.userId)).limit(1);
    expect(user?.admin).toBe(false);
  });

  it.each([
    [
      "an unknown token",
      async () => "not-a-real-token",
    ],
    [
      "an already-accepted invitation",
      async () => {
        const { token } = await createInvitation({
          organizationId: fixture.organizationId,
          email: "new-hire@client.example",
          role: ROLES.MEMBER,
          invitedBy: inviterId,
        });
        await redeemInvitation(token, "New Hire", PASSWORD);
        return token;
      },
    ],
    [
      "an expired invitation",
      async () => {
        const { invitation, token } = await createInvitation({
          organizationId: fixture.organizationId,
          email: "expired@client.example",
          role: ROLES.MEMBER,
          invitedBy: inviterId,
        });
        await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, invitation.id));
        return token;
      },
    ],
    [
      "a revoked invitation",
      async () => {
        const invitation = await inviteToOrganization(fixture.organizationId, { email: "ada@example.com", role: ROLES.MEMBER }, inviter());
        const [row] = await db.select().from(invitations).where(eq(invitations.id, invitation.id)).limit(1);
        await revokeInvitation(fixture.organizationId, invitation.id, inviter().actor);
        return row!.token;
      },
    ],
  ])("returns null for %s", async (_name, setup) => {
    expect(await redeemInvitation(await setup(), "Someone", PASSWORD)).toBeNull();
  });

  it("refuses to set a password on an address that already has an account", async () => {
    await seedAccount("ada@example.com");
    const { token } = await createInvitation({
      organizationId: fixture.organizationId,
      email: "ada@example.com",
      role: ROLES.MEMBER,
      invitedBy: inviterId,
    });

    await expect(redeemInvitation(token, "Not Ada", PASSWORD)).rejects.toBeInstanceOf(ApiError);
    expect(await db.select().from(memberships).where(eq(memberships.organizationId, fixture.organizationId))).toHaveLength(0);
  });
});

describe("acceptInvitationAs", () => {
  it("adds the membership to the account that already exists", async () => {
    const userId = await seedAccount("ada@example.com");
    const { token } = await createInvitation({
      organizationId: fixture.organizationId,
      email: "ada@example.com",
      role: ROLES.OWNER,
      invitedBy: inviterId,
    });

    const result = await acceptInvitationAs(token, { id: userId, email: "Ada@Example.com" });
    expect(result?.userId).toBe(userId);

    const rows = await db.select().from(memberships).where(eq(memberships.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe(ROLES.OWNER);
    expect(await db.select().from(users).where(eq(users.email, "ada@example.com"))).toHaveLength(1);
  });

  it("refuses a session signed in as somebody else", async () => {
    const otherId = await seedAccount("grace@example.com");
    const { token } = await createInvitation({
      organizationId: fixture.organizationId,
      email: "ada@example.com",
      role: ROLES.MEMBER,
      invitedBy: inviterId,
    });

    await expect(acceptInvitationAs(token, { id: otherId, email: "grace@example.com" })).rejects.toThrow(/This invitation is for/);
    expect(await db.select().from(memberships).where(eq(memberships.userId, otherId))).toHaveLength(0);
  });
});

describe("previewInvitation", () => {
  it("names the organization and whether an account is needed", async () => {
    const invitation = await inviteToOrganization(fixture.organizationId, { email: "ada@example.com", role: ROLES.MEMBER }, inviter());
    const [row] = await db.select().from(invitations).where(eq(invitations.id, invitation.id)).limit(1);

    expect(await previewInvitation(row!.token)).toMatchObject({
      state: "open",
      email: "ada@example.com",
      organizationName: "Test",
      needsAccount: true,
    });
  });

  it("tells expired and accepted apart, and says nothing at all about a revoked or unknown token", async () => {
    const accepted = await createInvitation({
      organizationId: fixture.organizationId,
      email: "accepted@example.com",
      role: ROLES.MEMBER,
      invitedBy: inviterId,
    });
    await redeemInvitation(accepted.token, "Accepted", PASSWORD);

    const expired = await createInvitation({
      organizationId: fixture.organizationId,
      email: "expired@example.com",
      role: ROLES.MEMBER,
      invitedBy: inviterId,
    });
    await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, expired.invitation.id));

    const revoked = await createInvitation({
      organizationId: fixture.organizationId,
      email: "revoked@example.com",
      role: ROLES.MEMBER,
      invitedBy: inviterId,
    });
    await revokeInvitation(fixture.organizationId, revoked.invitation.id, inviter().actor);

    expect((await previewInvitation(accepted.token)).state).toBe("accepted");
    expect((await previewInvitation(expired.token)).state).toBe("expired");
    expect(await previewInvitation(revoked.token)).toEqual({ state: "unknown" });
    expect(await previewInvitation("nonsense")).toEqual({ state: "unknown" });
  });
});

describe("resendInvitation", () => {
  it("mails a new token and kills the old link", async () => {
    const invitation = await inviteToOrganization(fixture.organizationId, { email: "ada@example.com", role: ROLES.MEMBER }, inviter());
    const [before] = await db.select().from(invitations).where(eq(invitations.id, invitation.id)).limit(1);

    await resendInvitation(fixture.organizationId, invitation.id, { name: "Inviter", actor: inviter().actor });

    const [after] = await db.select().from(invitations).where(eq(invitations.id, invitation.id)).limit(1);
    expect(after?.token).not.toBe(before?.token);
    expect(after!.expiresAt.getTime()).toBeGreaterThan(before!.expiresAt.getTime());
    expect(await redeemInvitation(before!.token, "Ada", PASSWORD)).toBeNull();
    expect(await systemMailMessages()).toHaveLength(2);
  });

  it("refuses a revoked invitation", async () => {
    const invitation = await inviteToOrganization(fixture.organizationId, { email: "ada@example.com", role: ROLES.MEMBER }, inviter());
    await revokeInvitation(fixture.organizationId, invitation.id, inviter().actor);

    await expect(resendInvitation(fixture.organizationId, invitation.id, { actor: inviter().actor })).rejects.toThrow(/already revoked/);
  });
});

describe("listOpenInvitations", () => {
  it("marks an expired invitation without hiding it, so it can be resent", async () => {
    const invitation = await inviteToOrganization(fixture.organizationId, { email: "ada@example.com", role: ROLES.MEMBER }, inviter());
    await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, invitation.id));

    const open = await listOpenInvitations(fixture.organizationId);
    expect(open).toHaveLength(1);
    expect(open[0]?.status).toBe("expired");
  });

  it("drops an invitation once it's accepted", async () => {
    const invitation = await inviteToOrganization(fixture.organizationId, { email: "ada@example.com", role: ROLES.MEMBER }, inviter());
    const [row] = await db.select().from(invitations).where(eq(invitations.id, invitation.id)).limit(1);
    await redeemInvitation(row!.token, "Ada", PASSWORD);

    expect(await listOpenInvitations(fixture.organizationId)).toHaveLength(0);
  });
});
