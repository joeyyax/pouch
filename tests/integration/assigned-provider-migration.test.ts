import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, providers } from "@/lib/db/schema";
import { encryptCredentials } from "@/lib/providers";
import { newId } from "@/lib/ids";
import { resetDatabase } from "./fixtures";

beforeEach(resetDatabase);

async function org(slug: string): Promise<string> {
  const id = newId("organization");
  await db.insert(organizations).values({ id, name: slug, slug });
  return id;
}

async function provider(organizationId: string | null, name: string, extra: Partial<typeof providers.$inferInsert> = {}): Promise<string> {
  const id = newId("provider");
  await db.insert(providers).values({ id, organizationId, adapter: "ses", name, credentials: encryptCredentials({}), ...extra });
  return id;
}

describe("0047 migration", () => {
  it("clears only the default when its provider is deleted", async () => {
    const id = await org("deleting");
    const row = await provider(id, "primary");
    await db.update(organizations).set({ providerId: row }).where(eq(organizations.id, id));

    await db.delete(providers).where(eq(providers.id, row));

    const [after] = await db.select().from(organizations).where(eq(organizations.id, id));
    expect(after).toMatchObject({ id, providerId: null });
  });

  it("refuses a default from another organization", async () => {
    const mine = await org("mine");
    const theirs = await provider(await org("theirs"), "primary");

    await expect(db.update(organizations).set({ providerId: theirs }).where(eq(organizations.id, mine))).rejects.toThrow();
  });
});
