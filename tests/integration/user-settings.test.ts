import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { passkeys, sessions, users } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { at } from "../at";
import {
  CurrentSessionError,
  LastCredentialError,
  NotOwnedError,
  hasPasswordCredential,
  listPasskeys,
  listSessions,
  removePasskey,
  revokeOtherSessions,
  revokeSession,
  updateName,
} from "@/lib/dashboard/user-settings";
import { resetDatabase, seedUser } from "./fixtures";

async function makeUser(name = "Test User"): Promise<{ userId: string; email: string }> {
  return seedUser({ name });
}

async function addPassword(userId: string, password = "correct horse battery staple"): Promise<void> {
  const ctx = await auth.$context;
  const passwordHash = await ctx.password.hash(password);
  await ctx.internalAdapter.linkAccount({
    userId,
    providerId: "credential",
    accountId: userId,
    password: passwordHash,
  });
}

async function addPasskey(userId: string, name: string | null = "Laptop"): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(passkeys).values({
    id,
    userId,
    name,
    publicKey: "test-public-key",
    credentialID: crypto.randomUUID(),
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
  });
  return id;
}

async function addSession(userId: string): Promise<{ id: string; token: string }> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  await db.insert(sessions).values({
    id,
    userId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    userAgent: "Mozilla/5.0 (test)",
    ipAddress: "127.0.0.1",
  });
  return { id, token };
}

/** Signs a user in through Better Auth itself and returns headers carrying its session cookie. */
async function signInHeaders(email: string, password: string): Promise<Headers> {
  const response = (await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  })) as Response;
  const cookieHeader = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  return new Headers({ cookie: cookieHeader });
}

beforeEach(resetDatabase);

describe("listPasskeys", () => {
  it("only returns the caller's own passkeys, with a recognizable label", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    await addPasskey(owner.userId, "Work laptop");
    await addPasskey(other.userId, "Someone else's key");

    const result = await listPasskeys(owner.userId);

    expect(result).toHaveLength(1);
    expect(at(result, 0).label).toBe("Work laptop");
  });

  it("falls back to a generic label when the passkey has no name", async () => {
    const owner = await makeUser();
    await addPasskey(owner.userId, null);

    const result = await listPasskeys(owner.userId);

    expect(at(result, 0).label).toBe("Passkey");
  });
});

describe("removePasskey", () => {
  it("refuses to remove the only passkey when there's no password on the provider", async () => {
    const owner = await makeUser();
    const passkeyId = await addPasskey(owner.userId);

    await expect(removePasskey(owner.userId, passkeyId, new Headers())).rejects.toThrow(LastCredentialError);

    const [row] = await db.select().from(passkeys).where(eq(passkeys.id, passkeyId));
    expect(row).toBeDefined();
  });

  it("allows removing the only passkey when the provider also has a password", async () => {
    const owner = await makeUser();
    await addPassword(owner.userId);
    const passkeyId = await addPasskey(owner.userId);
    const headers = await signInHeaders(owner.email, "correct horse battery staple");

    await removePasskey(owner.userId, passkeyId, headers);

    const [row] = await db.select().from(passkeys).where(eq(passkeys.id, passkeyId));
    expect(row).toBeUndefined();
  });

  it("allows removing one of several passkeys", async () => {
    const owner = await makeUser();
    await addPassword(owner.userId);
    const first = await addPasskey(owner.userId, "First");
    await addPasskey(owner.userId, "Second");
    const headers = await signInHeaders(owner.email, "correct horse battery staple");

    await removePasskey(owner.userId, first, headers);

    const remaining = await listPasskeys(owner.userId);
    expect(remaining.map((p) => p.label)).toEqual(["Second"]);
  });

  it("refuses to remove another user's passkey", async () => {
    const owner = await makeUser();
    const attacker = await makeUser();
    const passkeyId = await addPasskey(owner.userId);

    await expect(removePasskey(attacker.userId, passkeyId, new Headers())).rejects.toThrow(NotOwnedError);

    const [row] = await db.select().from(passkeys).where(eq(passkeys.id, passkeyId));
    expect(row).toBeDefined();
  });
});

describe("hasPasswordCredential", () => {
  it("is false until a credential provider is linked", async () => {
    const owner = await makeUser();
    expect(await hasPasswordCredential(owner.userId)).toBe(false);

    await addPassword(owner.userId);
    expect(await hasPasswordCredential(owner.userId)).toBe(true);
  });
});

describe("listSessions", () => {
  it("marks the session behind the request as current and excludes other users' sessions", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const mine = await addSession(owner.userId);
    await addSession(owner.userId);
    await addSession(other.userId);

    const result = await listSessions(owner.userId, mine.token);

    expect(result).toHaveLength(2);
    expect(result.find((s) => s.token === mine.token)?.current).toBe(true);
    expect(result.filter((s) => s.current)).toHaveLength(1);
  });
});

describe("revokeSession", () => {
  it("refuses to revoke another user's session — the load-bearing case", async () => {
    const owner = await makeUser();
    const attacker = await makeUser();
    const target = await addSession(owner.userId);

    await expect(revokeSession(attacker.userId, target.token, "not-the-target-token", new Headers())).rejects.toThrow(
      NotOwnedError,
    );

    const [row] = await db.select().from(sessions).where(eq(sessions.token, target.token));
    expect(row).toBeDefined();
  });

  it("refuses to revoke the session making the request", async () => {
    const owner = await makeUser();
    const current = await addSession(owner.userId);

    await expect(revokeSession(owner.userId, current.token, current.token, new Headers())).rejects.toThrow(
      CurrentSessionError,
    );

    const [row] = await db.select().from(sessions).where(eq(sessions.token, current.token));
    expect(row).toBeDefined();
  });

  it("revokes a session the caller owns that isn't the current one", async () => {
    const owner = await makeUser();
    await addPassword(owner.userId);
    const current = await signInHeaders(owner.email, "correct horse battery staple");
    const currentSession = await auth.api.getSession({ headers: current });
    const other = await addSession(owner.userId);

    await revokeSession(owner.userId, other.token, currentSession!.session.token, current);

    const [row] = await db.select().from(sessions).where(eq(sessions.token, other.token));
    expect(row).toBeUndefined();
  });
});

describe("updateName", () => {
  it("updates the caller's own name", async () => {
    const owner = await makeUser();
    await addPassword(owner.userId);
    const headers = await signInHeaders(owner.email, "correct horse battery staple");

    await updateName(owner.userId, "New Name", headers);

    const [row] = await db.select().from(users).where(eq(users.id, owner.userId));
    expect(row?.name).toBe("New Name");
  });
});

describe("revokeOtherSessions", () => {
  it("ends every session but the current one, and leaves another person's alone", async () => {
    const owner = await makeUser();
    await addPassword(owner.userId);
    const current = await signInHeaders(owner.email, "correct horse battery staple");
    const currentSession = await auth.api.getSession({ headers: current });
    await addSession(owner.userId);
    await addSession(owner.userId);
    const stranger = await makeUser();
    const theirs = await addSession(stranger.userId);

    expect(await revokeOtherSessions(owner.userId, currentSession!.session.token, current)).toBe(2);

    const left = await db.select({ token: sessions.token }).from(sessions).where(eq(sessions.userId, owner.userId));
    expect(left.map((row) => row.token)).toEqual([currentSession!.session.token]);
    expect(await db.select().from(sessions).where(eq(sessions.token, theirs.token))).toHaveLength(1);
  });
});
