import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, domains, memberships, organizations, providers, users } from "@/lib/db/schema";
import { ROLES } from "@/lib/auth/permissions";
import { resetDatabase } from "./fixtures";

const run = promisify(execFile);

/** Runs the bootstrap script against the test database, on the mock adapter so nothing leaves the box. */
async function seed(): Promise<void> {
  await run("pnpm", ["exec", "tsx", "scripts/seed.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: "correct horse battery staple",
      ADMIN_NAME: "Admin",
      SEED_ORGANIZATION_SLUG: "seed-test",
      SEED_PROVIDER_ADAPTER: "mock",
      SEED_PROVIDER_NAME: "primary",
      SEED_PROVIDER_CREDENTIALS: "{}",
      SEED_PROVIDER_SETTINGS: "{}",
      SEED_DOMAIN: "example.com",
      SEED_KEY_MODE: "live",
    },
  });
}

describe("pnpm seed", () => {
  beforeAll(async () => {
    await resetDatabase();
    await seed();
  });

  it("builds the provider's event plumbing, so the seeded domain isn't eventless", async () => {
    const [provider] = await db.select().from(providers).where(eq(providers.adapter, "mock")).limit(1);

    expect(provider?.settings.mockConfigured).toBe("true");
    expect(provider?.settings.mockTopic).toBe("example.com");
  });

  it("assigns the seeded provider to the seeded organization", async () => {
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, "seed-test"));
    const [provider] = await db.select().from(providers).where(eq(providers.organizationId, org!.id));
    expect(org?.providerId).toBe(provider?.id);
  });

  it("leaves the seeded domain pending, for the verify loop to confirm", async () => {
    const [domain] = await db.select().from(domains).where(eq(domains.name, "example.com")).limit(1);

    // Verified with no DNS records would claim the seed asked a provider something. It didn't.
    expect(domain?.status).toBe("pending");
    expect(domain?.verifiedAt).toBeNull();
  });

  it("gives the seeded admin a membership on the seeded organization, and the admin flag", async () => {
    const [admin] = await db.select().from(users).where(eq(users.email, "admin@example.com")).limit(1);
    expect(admin?.admin).toBe(true);

    const [membership] = await db.select().from(memberships).where(eq(memberships.userId, admin!.id)).limit(1);
    expect(membership?.organizationId).toBe(admin!.organizationId);
    expect(membership?.role).toBe(ROLES.OWNER);
  });

  it("mints the bootstrap key unscoped, not pinned to the one domain it seeded alongside it (#185)", async () => {
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.name, "bootstrap")).limit(1);
    expect(key?.domainIds).toEqual([]);
  });
});

describe("pnpm seed run twice", () => {
  beforeEach(resetDatabase);

  it("is idempotent: running it again against the same admin doesn't duplicate the membership", async () => {
    await seed();
    await seed();

    const [admin] = await db.select().from(users).where(eq(users.email, "admin@example.com")).limit(1);
    const rows = await db.select().from(memberships).where(eq(memberships.userId, admin!.id));
    expect(rows).toHaveLength(1);
  });
});
