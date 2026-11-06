import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, users } from "@/lib/db/schema";
import { hashIp } from "@/lib/api/client-ip";
import { auth } from "@/lib/auth";
import { POST } from "@/app/api/auth/[...all]/route";
import { resetDatabase, seedFixture } from "./fixtures";

function signUp(body: unknown): Request {
  return new Request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function signIn(body: unknown): Request {
  return new Request("http://localhost/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(resetDatabase);

describe("POST /api/auth/sign-up/email", () => {
  it("rejects public sign-up, even with a real organization id", async () => {
    const fixture = await seedFixture();

    const response = await POST(
      signUp({
        email: "intruder@example.net",
        password: "correct horse battery staple",
        name: "Intruder",
        organizationId: fixture.organizationId,
      }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);

    const created = await db.select().from(users).where(eq(users.email, "intruder@example.net"));
    expect(created).toHaveLength(0);
  });
});

describe("admin creation with public sign-up disabled", () => {
  it("can sign in a user created through the internal adapter, the way the seed script creates the admin", async () => {
    const fixture = await seedFixture();
    const password = "correct horse battery staple";

    const ctx = await auth.$context;
    const passwordHash = await ctx.password.hash(password);
    const created = await ctx.internalAdapter.createUser(
      {
        email: "admin@example.net",
        name: "Admin",
        organizationId: fixture.organizationId,
        emailVerified: true,
      },
      { method: "admin" },
    );
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: "credential",
      accountId: created.id,
      password: passwordHash,
    });

    const response = await POST(signIn({ email: "admin@example.net", password }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    expect(body.user.id).toBe(created.id);
  });
});

describe("a refused sign-in", () => {
  async function seedAccount(password: string): Promise<{ userId: string; organizationId: string }> {
    const { organizationId } = await seedFixture();
    const ctx = await auth.$context;
    const created = await ctx.internalAdapter.createUser(
      { email: "ada@example.net", name: "Ada", organizationId, emailVerified: true },
      { method: "admin" },
    );
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: "credential",
      accountId: created.id,
      password: await ctx.password.hash(password),
    });
    return { userId: created.id, organizationId };
  }

  function signInFrom(body: unknown): Request {
    const request = signIn(body);
    request.headers.set("x-forwarded-for", "203.0.113.9");
    request.headers.set("user-agent", "TestAgent/1.0");
    return request;
  }

  const failures = () => db.select().from(activity).where(eq(activity.action, "session.sign_in.failed"));

  it("records the failure against the account, with the hashed address and user agent", async () => {
    const { userId, organizationId } = await seedAccount("correct horse battery staple");

    const response = await POST(signInFrom({ email: "ada@example.net", password: "wrong password here" }));
    expect(response.status).toBeGreaterThanOrEqual(400);

    const rows = await failures();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organizationId).toBe(organizationId);
    expect(rows[0]?.actorId).toBe(userId);
    expect(rows[0]?.ipHash).toBe(hashIp("203.0.113.9"));
    expect(rows[0]?.userAgent).toBe("TestAgent/1.0");
  });

  it("records nothing for a correct password or an address with no account", async () => {
    await seedAccount("correct horse battery staple");

    const ok = await POST(signInFrom({ email: "ada@example.net", password: "correct horse battery staple" }));
    expect(ok.status).toBe(200);
    await POST(signInFrom({ email: "nobody@example.net", password: "whatever it is" }));

    expect(await failures()).toHaveLength(0);
  });

  it("can't be recorded from a client: the server action is gone", async () => {
    const actions = (await import("@/app/(auth)/login/actions")) as Record<string, unknown>;
    expect(actions.recordSignInFailedAction).toBeUndefined();
    expect(actions.recordSignInAction).toBeTypeOf("function");
  });
});
