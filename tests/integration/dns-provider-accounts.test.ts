import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { dnsProviderAccounts } from "@/lib/db/schema";
import { createDnsProviderAccount, decryptCredentials } from "@/lib/dns-providers/accounts";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
});
afterEach(() => vi.unstubAllGlobals());

describe("createDnsProviderAccount", () => {
  it("stores credentials encrypted after the mock module's check passes", async () => {
    const row = await createDnsProviderAccount(fixture.organizationId, {
      module: "mock",
      name: "primary",
      credentials: {},
    });

    expect(row.id).toMatch(/^dpa_/);
    expect(row.credentials_verified).toBe(true);

    const [stored] = await db.select().from(dnsProviderAccounts).where(eq(dnsProviderAccounts.id, row.id)).limit(1);
    if (!stored) throw new Error("expected the row to be stored");
    expect(stored.credentials).not.toContain("token");
    expect(decryptCredentials(stored)).toEqual({});
  });

  it("refuses a token that fails Cloudflare's verify call, and stores nothing", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }), { status: 401 }),
    );

    await expect(
      createDnsProviderAccount(fixture.organizationId, {
        module: "cloudflare",
        name: "cf",
        credentials: { token: "a".repeat(40) },
      }),
    ).rejects.toThrow(ApiError);

    const rows = await db.select().from(dnsProviderAccounts).where(eq(dnsProviderAccounts.organizationId, fixture.organizationId));
    expect(rows).toHaveLength(0);
  });

  it("refuses a global-key-shaped token before making a network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      createDnsProviderAccount(fixture.organizationId, {
        module: "cloudflare",
        name: "cf",
        credentials: { token: "0123456789abcdef0123456789abcdef01234" },
      }),
    ).rejects.toThrow(/valid/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stores a working Cloudflare token once its verify call succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ success: true, errors: [], result: { id: "t1", status: "active" } }), { status: 200 }),
    );

    const row = await createDnsProviderAccount(fixture.organizationId, {
      module: "cloudflare",
      name: "cf",
      credentials: { token: "a".repeat(40) },
    });
    expect(row.credentials_verified).toBe(true);
  });

  it("refuses a second account with the same name in the organization", async () => {
    await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });
    await expect(createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} })).rejects.toThrow(
      ApiError,
    );
  });
});
