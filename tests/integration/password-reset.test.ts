import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, domains, sessions, verifications } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { settleAuthBackgroundTasks } from "@/lib/auth/password-reset";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { setSystemFromAddress } from "@/lib/settings/service";
import { closeRedis } from "@/lib/redis";
import { readBody } from "@/lib/storage/bodies";
import { POST } from "@/app/api/auth/[...all]/route";
import { resetDatabase, seedFixture, seedSystemOrganization, systemMailMessages } from "./fixtures";
import { clearRedisKeys, testRedisUrl } from "../redis";

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a different long passphrase";
const EMAIL = "admin@example.net";

let organizationId: string;
let userId: string;

function post(path: string, body: unknown, address = "203.0.113.10"): Request {
  return new Request(`http://localhost/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": address },
    body: JSON.stringify(body),
  });
}

async function requestReset(email: string, address?: string): Promise<Response> {
  const response = await POST(post("request-password-reset", { email }, address));
  await settleAuthBackgroundTasks();
  return response;
}

async function tokenFromMail(): Promise<string> {
  const [message] = await systemMailMessages();
  const body = await readBody(Buffer.from(message!.bodyKey ?? "", "base64"), message!.storageKey ?? "");
  const link = body.text?.match(/https?:\/\/\S+/)?.[0];
  expect(link).toBeTruthy();
  const url = new URL(link!);
  expect(url.pathname).toBe("/reset-password");
  return url.searchParams.get("token")!;
}

async function signIn(password: string): Promise<Response> {
  return POST(post("sign-in/email", { email: EMAIL, password }));
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(verifications);
  resetRateLimitMemory();
  const fixture = await seedFixture();
  organizationId = fixture.organizationId;

  const ctx = await auth.$context;
  const created = await ctx.internalAdapter.createUser(
    { email: EMAIL, name: "Admin", organizationId, emailVerified: true },
    { method: "admin" },
  );
  userId = created.id;
  await ctx.internalAdapter.linkAccount({
    userId,
    providerId: "credential",
    accountId: userId,
    password: await ctx.password.hash(PASSWORD),
  });
});

describe("POST /api/auth/request-password-reset", () => {
  it("sends one email through the system organization", async () => {
    await seedSystemOrganization();

    const response = await requestReset(EMAIL);

    expect(response.status).toBe(200);
    const sent = await systemMailMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.recipients).toEqual([EMAIL]);
    expect(sent[0]!.subject).toMatch(/Reset your .+ password/);
    expect(await tokenFromMail()).toBeTruthy();

    const rows = await db.select().from(activity).where(eq(activity.organizationId, organizationId));
    expect(rows.map((row) => row.action)).toEqual(["session.password_reset.requested"]);
  });

  it("answers an unknown address the same way and sends nothing", async () => {
    await seedSystemOrganization();

    const known = await requestReset(EMAIL, "203.0.113.11");
    const unknown = await requestReset("nobody@example.net", "203.0.113.12");

    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
    expect(await systemMailMessages()).toHaveLength(1);
  });

  it("says plainly when no domain is verified to send from, for any address", async () => {
    await db.update(domains).set({ status: "pending", verifiedAt: null });

    const known = await requestReset(EMAIL);
    const unknown = await requestReset("nobody@example.net");

    for (const response of [known, unknown]) {
      expect(response.status).toBe(503);
      const body = (await response.json()) as { message: string };
      expect(body.message).toContain("system from address");
      expect(body.message).toContain("pnpm reset:admin");
    }
  });

  it("treats an address on a domain that's gone as not set up", async () => {
    await setSystemFromAddress("support@gone.example");

    expect((await requestReset(EMAIL)).status).toBe(503);
  });

  it("limits requests from one client address", async () => {
    await seedSystemOrganization();
    process.env.PASSWORD_RESET_RATE_LIMIT = "2";
    try {
      await requestReset("a@example.net");
      await requestReset("b@example.net");
      const limited = await requestReset("c@example.net");

      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      expect((await requestReset("d@example.net", "203.0.113.99")).status).toBe(200);
    } finally {
      delete process.env.PASSWORD_RESET_RATE_LIMIT;
    }
  });

  it("limits requests for one email address across client addresses, and sends no more mail", async () => {
    await seedSystemOrganization();

    for (let i = 0; i < 3; i++) expect((await requestReset(EMAIL, `198.51.100.${i}`)).status).toBe(200);
    const limited = await requestReset(EMAIL, "198.51.100.50");

    expect(limited.status).toBe(429);
    expect(await systemMailMessages()).toHaveLength(3);
  });

  describe("with Redis", () => {
    afterEach(async () => {
      await clearRedisKeys("ratelimit:password-reset");
      delete process.env.REDIS_URL;
      await closeRedis();
    });

    it("counts in Redis, not in process memory", async () => {
      process.env.REDIS_URL = testRedisUrl();
      await seedSystemOrganization();

      for (let i = 0; i < 3; i++) await requestReset("nobody@example.net", `192.0.2.${i}`);
      resetRateLimitMemory();

      expect((await requestReset("nobody@example.net", "192.0.2.50")).status).toBe(429);
    });
  });
});

describe("POST /api/auth/reset-password", () => {
  beforeEach(async () => {
    await seedSystemOrganization();
  });

  it("sets the new password with a token that works once", async () => {
    await requestReset(EMAIL);
    const token = await tokenFromMail();

    const first = await POST(post("reset-password", { token, newPassword: NEW_PASSWORD }));
    expect(first.status).toBe(200);

    const second = await POST(post("reset-password", { token, newPassword: "yet another passphrase" }));
    expect(second.status).toBe(400);

    expect((await signIn(PASSWORD)).status).toBe(401);
    expect((await signIn(NEW_PASSWORD)).status).toBe(200);

    const rows = await db
      .select()
      .from(activity)
      .where(and(eq(activity.organizationId, organizationId), eq(activity.action, "session.password_reset.completed")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBe(userId);
  });

  it("revokes every session the user holds", async () => {
    expect((await signIn(PASSWORD)).status).toBe(200);
    expect((await signIn(PASSWORD)).status).toBe(200);
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(2);

    await requestReset(EMAIL);
    const token = await tokenFromMail();
    expect((await POST(post("reset-password", { token, newPassword: NEW_PASSWORD }))).status).toBe(200);

    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(0);
  });

  it("issues a token for one hour and refuses it after", async () => {
    await requestReset(EMAIL);
    const token = await tokenFromMail();

    const [row] = await db.select().from(verifications);
    expect(row!.identifier).not.toContain(token);
    const ttlMs = row!.expiresAt.getTime() - row!.createdAt.getTime();
    expect(Math.abs(ttlMs - 60 * 60 * 1000)).toBeLessThan(5000);

    await db.update(verifications).set({ expiresAt: sql`now() - interval '1 second'` });
    const response = await POST(post("reset-password", { token, newPassword: NEW_PASSWORD }));

    expect(response.status).toBe(400);
    expect((await signIn(PASSWORD)).status).toBe(200);
  });
});
