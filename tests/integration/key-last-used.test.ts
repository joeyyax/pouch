import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";
import { GET } from "@/app/api/v1/suppressions/route";
import { DELETE } from "@/app/api/v1/suppressions/[address]/route";
import { resetKeyUseMemory } from "@/lib/api/keys";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { seedAdmin } from "./admin-fixtures";
import { addSuppression, resetDatabase, seedFixture } from "./fixtures";

async function lastUsedAt(keyId: string): Promise<Date | null> {
  const [row] = await db.select({ lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);
  return row?.lastUsedAt ?? null;
}

function list(secret: string): Promise<Response> {
  return GET(new Request("http://localhost/v1/suppressions", { headers: { authorization: `Bearer ${secret}` } }));
}

function remove(secret: string, address: string): Promise<Response> {
  return DELETE(
    new Request(`http://localhost/v1/suppressions/${encodeURIComponent(address)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${secret}` },
    }),
    { params: Promise.resolve({ address }) },
  );
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  resetKeyUseMemory();
});

describe("last_used_at", () => {
  it("records a read", async () => {
    const fixture = await seedFixture({ scopeToDomain: false });

    expect((await list(fixture.secret)).status).toBe(200);

    expect(await lastUsedAt(fixture.key.id)).not.toBeNull();
  });

  it("records a [param] route", async () => {
    const fixture = await seedFixture({ scopeToDomain: false });
    await addSuppression(fixture.organizationId, "gone@example.net");

    expect((await remove(fixture.secret, "gone@example.net")).status).toBe(200);

    expect(await lastUsedAt(fixture.key.id)).not.toBeNull();
  });

  it("records a request the route refuses", async () => {
    const admin = await seedAdmin();

    expect((await list(admin.secret)).status).toBe(403);

    expect(await lastUsedAt(admin.keyId)).not.toBeNull();
  });

  it("leaves the stamp alone for the rest of the window", async () => {
    const fixture = await seedFixture({ scopeToDomain: false });

    await list(fixture.secret);
    const first = await lastUsedAt(fixture.key.id);
    await list(fixture.secret);

    expect(await lastUsedAt(fixture.key.id)).toEqual(first);
  });

  it("stamps again once the window is over", async () => {
    const fixture = await seedFixture({ scopeToDomain: false });
    const stale = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db.update(apiKeys).set({ lastUsedAt: stale }).where(eq(apiKeys.id, fixture.key.id));

    await list(fixture.secret);

    expect((await lastUsedAt(fixture.key.id))?.getTime()).toBeGreaterThan(stale.getTime());
  });
});
