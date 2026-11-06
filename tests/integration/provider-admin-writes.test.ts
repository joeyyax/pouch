import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, organizations, providers } from "@/lib/db/schema";
import { decryptCredentials, type ProviderCaller } from "@/lib/providers";
import { deleteProvider, probeProvider, updateProvider } from "@/lib/providers/admin";
import { createSingleOrgProvider } from "@/lib/providers/assignment";
import { userActor } from "@/lib/activity/record";
import { ApiError } from "@/lib/api/errors";
import { newId } from "@/lib/ids";
import { createProviderSchema } from "@/lib/schemas/provider";
import { addProvider, resetDatabase, seedFixture, type Fixture } from "./fixtures";

let fixture: Fixture;

function callerOf(f: Fixture, domainIds: string[] = []): ProviderCaller {
  return { organizationId: f.organizationId, domainIds, actor: userActor("usr_admin", "Admin") };
}

const operator = userActor("usr_admin", "Admin");

function create(organizationId: string, body: Record<string, unknown>) {
  return createSingleOrgProvider(createProviderSchema.parse(body), organizationId, operator);
}

/** An organization with no provider: a create needs the room the assignment limit leaves. */
async function emptyOrganization(): Promise<string> {
  const id = newId("organization");
  await db.insert(organizations).values({ id, name: "Empty", slug: `empty-${id}` });
  return id;
}

async function errorOf(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(error instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(error)}`);
  return error;
}

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
});
afterEach(() => vi.unstubAllGlobals());

async function activityFor(providerId: string): Promise<{ action: string; metadata: unknown }[]> {
  const rows = await db.select().from(activity).where(eq(activity.appliesTo, providerId));
  return rows.map((row) => ({ action: row.action, metadata: row.metadata }));
}

async function rowOf(providerId: string) {
  const [row] = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
  if (!row) throw new Error("provider disappeared");
  return row;
}

describe("createSingleOrgProvider", () => {
  it("creates a provider with the mock adapter, which always passes its check", async () => {
    const { provider, verified } = await create(await emptyOrganization(), { adapter: "mock", name: "secondary", credentials: {} });

    expect(provider.id).toMatch(/^pac_/);
    expect(provider).toMatchObject({ adapter: "mock", name: "secondary" });
    expect(verified).toBe(true);
    expect((await rowOf(provider.id)).concurrency).toBe(16);
  });

  it("records a create row with no credential value in it", async () => {
    const { provider } = await create(await emptyOrganization(), { adapter: "mock", name: "secondary", credentials: { secret: "shh" } });

    const rows = await activityFor(provider.id);
    expect(rows.map((row) => row.action)).toEqual(["provider.created"]);
    expect(JSON.stringify(rows)).not.toContain("shh");
  });

  it("refuses a duplicate name, across adapters too", async () => {
    for (const body of [
      { adapter: "mock", name: "primary", credentials: {} },
      { adapter: "mailpace", name: "primary", credentials: { serverToken: "t" } },
    ]) {
      const error = await errorOf(create(fixture.organizationId, body));
      expect(error.code).toBe("provider_exists");
      expect(error.field).toBe("name");
    }
  });

  it("checks credentials live before storing, and refuses ones the provider rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid token" }), { status: 401 })));

    const error = await errorOf(
      create(await emptyOrganization(), { adapter: "mailpace", name: "rotated", credentials: { serverToken: "bad", organizationToken: "bad" } }),
    );

    expect(error.code).toBe("credentials_rejected");
    expect(error.message).not.toContain("invalid token");
    expect(await db.select().from(providers).where(eq(providers.name, "rotated"))).toEqual([]);
  });

  it("stores credentials for an adapter with no way to check itself, and says so", async () => {
    const checked = await create(await emptyOrganization(), { adapter: "mock", name: "checked", credentials: {} });
    const unchecked = await create(await emptyOrganization(), { adapter: "mailpace", name: "unchecked", credentials: { serverToken: "t" } });

    expect(checked.verified).toBe(true);
    expect(unchecked.verified).toBeNull();
    expect((await activityFor(unchecked.provider.id))[0]?.metadata).toMatchObject({ verified: null });
  });

  it("rejects credentials that don't match the adapter's schema", async () => {
    const error = await errorOf(create(await emptyOrganization(), { adapter: "mailpace", name: "bad-shape", credentials: {} }));

    expect(error.code).toBe("validation_failed");
    expect(error.field).toBe("credentials");
  });

  it("refuses a second provider for an organization that already has one", async () => {
    const error = await errorOf(create(fixture.organizationId, { adapter: "mock", name: "secondary", credentials: {} }));

    expect(error.code).toBe("validation_failed");
    expect(error.field).toBe("organization_id");
  });
});

describe("updateProvider", () => {
  it("changes the name and records a settings-changed row", async () => {
    const body = await updateProvider(callerOf(fixture), fixture.providerId, { name: "renamed" });

    expect(body.name).toBe("renamed");
    expect(body).not.toHaveProperty("credentials_verified");
    expect((await activityFor(fixture.providerId)).map((row) => row.action)).toEqual(["provider.settings.changed"]);
  });

  it("merges settings rather than replacing them", async () => {
    await db.update(providers).set({ settings: { keepMe: "yes" } }).where(eq(providers.id, fixture.providerId));

    await updateProvider(callerOf(fixture), fixture.providerId, { settings: { mockConfigured: "true" } });

    expect((await rowOf(fixture.providerId)).settings).toEqual({ keepMe: "yes", mockConfigured: "true" });
  });

  it("checks new credentials live and leaves the old ones stored on refusal", async () => {
    const mailpace = await seedFixture({ scopeToDomain: false, providerAdapter: "mailpace", credentials: { serverToken: "good", organizationToken: "good" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 401 })));

    const error = await errorOf(
      updateProvider(callerOf(mailpace), mailpace.providerId, { credentials: { serverToken: "bad", organizationToken: "bad" } }),
    );

    expect(error.code).toBe("credentials_rejected");
    expect(decryptCredentials(await rowOf(mailpace.providerId))).toEqual({ serverToken: "good", organizationToken: "good" });
    expect(await activityFor(mailpace.providerId)).toEqual([]);
  });

  it("replaces credentials that pass the check and records the change with no secret in it", async () => {
    const mailpace = await seedFixture({ scopeToDomain: false, providerAdapter: "mailpace", credentials: { serverToken: "old", organizationToken: "old" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));

    const body = await updateProvider(callerOf(mailpace), mailpace.providerId, {
      credentials: { serverToken: "new-secret-value", organizationToken: "new-org-value" },
    });

    expect(body.credentials_verified).toBe(true);
    expect(decryptCredentials(await rowOf(mailpace.providerId))).toEqual({
      serverToken: "new-secret-value",
      organizationToken: "new-org-value",
    });
    const rows = await activityFor(mailpace.providerId);
    expect(rows.map((row) => row.action)).toEqual(["provider.credentials.replaced"]);
    expect(JSON.stringify(rows)).not.toContain("new-secret-value");
    expect(JSON.stringify(rows)).not.toContain("new-org-value");
  });

  it("accepts a credential change it can't verify, and says so rather than reading as a pass", async () => {
    const mailpace = await seedFixture({ scopeToDomain: false, providerAdapter: "mailpace", credentials: { serverToken: "old" } });

    const body = await updateProvider(callerOf(mailpace), mailpace.providerId, {
      credentials: { serverToken: "definitely-not-a-real-token" },
    });

    expect(body.credentials_verified).toBeNull();
    expect(decryptCredentials(await rowOf(mailpace.providerId))).toEqual({ serverToken: "definitely-not-a-real-token" });
  });

  it("refuses a rename onto a name already used by another provider", async () => {
    const { providerId } = await addProvider(fixture, { providerAdapter: "mailpace", name: "backup" });

    const error = await errorOf(updateProvider(callerOf(fixture), providerId, { name: "primary" }));

    expect(error.code).toBe("provider_exists");
    expect(error.field).toBe("name");
    expect((await rowOf(providerId)).name).toBe("backup");
  });

  it("allows renaming a provider to the name it already has", async () => {
    await expect(updateProvider(callerOf(fixture), fixture.providerId, { name: "primary" })).resolves.toMatchObject({
      name: "primary",
    });
  });
});

describe("probeProvider", () => {
  it("runs the live check without changing the provider", async () => {
    const before = await rowOf(fixture.providerId);
    const health = await probeProvider(before);

    expect(health).toMatchObject({ ok: true, detail: null });
    expect(await rowOf(fixture.providerId)).toEqual(before);
  });
});

describe("deleteProvider", () => {
  it("refuses a provider with a domain still bound, naming it", async () => {
    const error = await errorOf(deleteProvider(callerOf(fixture), fixture.providerId));

    expect(error.code).toBe("provider_in_use");
    expect(error.message).toContain("example.com");
    expect(error.detail?.domains).toEqual(["example.com"]);
  });

  it("deletes a provider nothing is bound to and records the row", async () => {
    const { providerId } = await addProvider(fixture, { providerAdapter: "mock", name: "unbound" });

    expect(await deleteProvider(callerOf(fixture), providerId)).toEqual({ id: providerId, deleted: true });
    expect(await db.select().from(providers).where(eq(providers.id, providerId))).toEqual([]);
    expect((await activityFor(providerId)).map((r) => r.action)).toContain("provider.deleted");
  });
});
