import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { signInDevAccountAction } from "@/app/(auth)/login/dev-sign-in-action";
import { DEV_ACCOUNTS, DEV_PASSWORD, devSignInEnabled } from "@/lib/dev/seed-accounts";
import { resetDatabase, seedFixture } from "./fixtures";

/** Same creation path `scripts/dev-data.ts` and `scripts/seed.ts` use: Better Auth's internal
 * adapter, never the public sign-up path. */
async function seedDevOperator(): Promise<void> {
  const fixture = await seedFixture();
  const ctx = await auth.$context;
  const passwordHash = await ctx.password.hash(DEV_PASSWORD);
  const created = await ctx.internalAdapter.createUser(
    { email: DEV_ACCOUNTS.admin.email, name: DEV_ACCOUNTS.admin.name, organizationId: fixture.organizationId, emailVerified: true },
    { method: "admin" },
  );
  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: "credential",
    accountId: created.id,
    password: passwordHash,
  });
  await db.update(users).set({ admin: true }).where(eq(users.id, created.id));
}

beforeEach(resetDatabase);

describe("devSignInEnabled", () => {
  it("is true outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    try {
      expect(devSignInEnabled()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is false under a production NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(devSignInEnabled()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("signInDevAccountAction", () => {
  it("refuses under a production NODE_ENV, even for a real seeded provider with the right password", async () => {
    await seedDevOperator();
    vi.stubEnv("NODE_ENV", "production");
    try {
      const result = await signInDevAccountAction("admin");
      expect(result.ok).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a key that isn't one of the seeded providers", async () => {
    const result = await signInDevAccountAction("not-a-real-provider");
    expect(result.ok).toBe(false);
  });

  it("signs in through the real credential check outside production", async () => {
    await seedDevOperator();

    const result = await signInDevAccountAction("admin");

    expect(result.ok).toBe(true);
  });
});
