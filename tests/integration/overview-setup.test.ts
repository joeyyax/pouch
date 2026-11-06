import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, domains, organizations } from "@/lib/db/schema";
import { readSetupState } from "@/lib/dashboard/overview-setup";
import { newId } from "@/lib/ids";
import { resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ domainStatus: "pending", keyMode: "test" });
});

describe("readSetupState", () => {
  it("reads an organization with nothing as nothing", async () => {
    const organizationId = newId("organization");
    await db.insert(organizations).values({ id: organizationId, name: "Empty", slug: `empty-${organizationId}` });

    expect(await readSetupState(organizationId, false)).toEqual({
      assigned: false,
      domainCount: 0,
      unverified: null,
      verified: null,
      keyCount: 0,
      liveKeyCount: 0,
      sent: null,
    });
  });

  it("names the pending domain until it verifies", async () => {
    const pending = await readSetupState(fixture.organizationId, true);
    expect(pending.domainCount).toBe(1);
    expect(pending.unverified).toMatchObject({ id: fixture.domainId, status: "pending" });
    expect(pending.verified).toBeNull();

    await db.update(domains).set({ status: "verified", verifiedAt: new Date() }).where(eq(domains.id, fixture.domainId));
    const verified = await readSetupState(fixture.organizationId, true);
    expect(verified.unverified).toBeNull();
    expect(verified.verified).toMatchObject({ id: fixture.domainId, name: "example.com" });
  });

  it("counts test keys apart from live ones and leaves revoked ones out", async () => {
    const before = await readSetupState(fixture.organizationId, true);
    expect(before.keyCount).toBe(1);
    expect(before.liveKeyCount).toBe(0);

    await db.update(apiKeys).set({ mode: "live" }).where(eq(apiKeys.id, fixture.key.id));
    expect((await readSetupState(fixture.organizationId, true)).liveKeyCount).toBe(1);

    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, fixture.key.id));
    const revoked = await readSetupState(fixture.organizationId, true);
    expect(revoked.keyCount).toBe(0);
    expect(revoked.liveKeyCount).toBe(0);
  });

  it("tells a test-only send from a live one", async () => {
    expect((await readSetupState(fixture.organizationId, true)).sent).toBeNull();

    await seedMessage(fixture, { testMode: true });
    expect((await readSetupState(fixture.organizationId, true)).sent).toBe("test");

    await seedMessage(fixture, { testMode: false });
    expect((await readSetupState(fixture.organizationId, true)).sent).toBe("live");
  });

  it("reads only its own organization", async () => {
    const other = await seedFixture();
    await seedMessage(other);

    const state = await readSetupState(fixture.organizationId, true);
    expect(state.sent).toBeNull();
    expect(state.verified).toBeNull();
    expect(state.keyCount).toBe(1);
  });
});
