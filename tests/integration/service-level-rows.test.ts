import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { apiKeys, organizations, providers } from "@/lib/db/schema";
import { encryptCredentials } from "@/lib/providers";
import { createApiKey } from "@/lib/api/key-lifecycle";
import { newId } from "@/lib/ids";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

async function provider(values: Partial<typeof providers.$inferInsert> = {}, tx: Executor = db): Promise<string> {
  const id = newId("provider");
  await tx.insert(providers).values({ id, adapter: "ses", name: "provider", credentials: encryptCredentials({}), ...values });
  return id;
}

async function rowOf(id: string, tx: Executor = db) {
  const [row] = await tx.select().from(providers).where(eq(providers.id, id));
  return row;
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

describe("the database holds the invariants", () => {
  it("refuses a shared provider with an organization, and one that isn't shared without", async () => {
    await expect(provider({ shared: true, organizationId: fixture.organizationId, name: "both" })).rejects.toThrow();
    await expect(provider({ shared: false, name: "neither" })).rejects.toThrow();
  });

  it("refuses an admin key with an organization, and an organization key without", async () => {
    await expect(
      db.insert(apiKeys).values({ id: newId("key"), organizationId: fixture.organizationId, name: "a", scope: "admin", secretHash: "h1", secretPrefix: "p" }),
    ).rejects.toThrow();
    await expect(db.insert(apiKeys).values({ id: newId("key"), name: "b", secretHash: "h2", secretPrefix: "p" })).rejects.toThrow();
  });

  it("keeps shared provider names unique among themselves, apart from an organization's own", async () => {
    await provider({ shared: true, name: "Hosted" });
    await expect(provider({ shared: true, name: "Hosted" })).rejects.toThrow();
    await expect(provider({ organizationId: fixture.organizationId, name: "Hosted" })).resolves.toBeTruthy();
  });
});

describe("deleting an organization", () => {
  it("takes its own providers and keys, and never a service-level row", async () => {
    const sharedId = await provider({ shared: true, name: "Hosted" });
    const adminUserId = crypto.randomUUID();
    await db.execute(
      sql`insert into "users" ("id", "organization_id", "name", "email", "admin") values (${adminUserId}, ${fixture.organizationId}, 'Admin', ${`${adminUserId}@example.com`}, true)`,
    );
    const { key: adminKey } = await createApiKey({ organizationId: null, name: "admin", mode: "live", domainIds: [], scope: "admin", createdBy: adminUserId });
    const tenantId = await provider({ organizationId: fixture.organizationId, name: "tenant", sharedProviderId: sharedId });

    await db.delete(organizations).where(eq(organizations.id, fixture.organizationId));

    expect(await rowOf(tenantId)).toBeUndefined();
    expect(await rowOf(fixture.providerId)).toBeUndefined();
    expect(await db.select().from(apiKeys).where(eq(apiKeys.id, fixture.key.id))).toHaveLength(0);
    expect(await rowOf(sharedId)).toMatchObject({ id: sharedId, organizationId: null });
    expect(await db.select().from(apiKeys).where(eq(apiKeys.id, adminKey.id))).toHaveLength(1);
  });
});
