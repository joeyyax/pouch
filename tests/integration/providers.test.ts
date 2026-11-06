import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, organizations, providers } from "@/lib/db/schema";
import { encryptCredentials } from "@/lib/providers";
import { recordProviderProbe } from "@/lib/health/checks";
import { newId } from "@/lib/ids";
import { closeRedis } from "@/lib/redis";
import { POST as unmatched } from "@/app/api/[...path]/route";
import * as one from "@/app/api/v1/providers/[id]/route";
import * as collection from "@/app/api/v1/providers/route";
import { addProvider, apiRequest, resetDatabase, routeContext, seedFixture, type Fixture } from "./fixtures";
import { testRedisUrl } from "../redis";

interface OrganizationProvider {
  id: string;
  adapter: string;
  name: string;
  assigned: boolean;
  status: string;
  backoff_until: string | null;
  created_at: string;
  updated_at: string;
}

interface ErrorBody {
  error: { code: string; message: string; field?: string };
}

const AWS_ACCOUNT = "210987654321";
const TENANT_SETTINGS = {
  tenantName: "org-x",
  tenantArn: `arn:aws:ses:us-west-2:${AWS_ACCOUNT}:tenant/org-x/tn-1`,
  topicArn: `arn:aws:sns:us-west-2:${AWS_ACCOUNT}:mail-events-x`,
  configurationSetName: "mail-events-x",
  mockConfigured: "true",
};

const request = (secret: string, path: string, method = "GET", body?: unknown): Request =>
  apiRequest(secret, `/v1/providers${path}`, method, body);

/** Calls a handler the way Next does, with the route context, whatever its declared arity. */
function call(handler: unknown, req: Request, id: string): Promise<Response> {
  return (handler as (r: Request, c: ReturnType<typeof routeContext>) => Promise<Response>)(req, routeContext(id));
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
});
afterEach(async () => {
  delete process.env.REDIS_URL;
  await closeRedis();
});

async function rowOf(id: string) {
  const [row] = await db.select().from(providers).where(eq(providers.id, id)).limit(1);
  return row;
}

async function readOne(id: string): Promise<OrganizationProvider> {
  const response = await one.GET(request(fixture.secret, `/${id}`), routeContext(id));
  expect(response.status).toBe(200);
  return (await response.json()) as OrganizationProvider;
}

/** Makes the fixture's provider a tenant of a shared provider. */
async function makeTenant(settings: Record<string, string>): Promise<string> {
  const parentId = newId("provider");
  await db.insert(providers).values({
    id: parentId,
    adapter: "mock",
    name: "shared",
    shared: true,
    credentials: encryptCredentials({ serverToken: "shared-secret" }),
    settings: TENANT_SETTINGS,
  });
  await db
    .update(providers)
    .set({ sharedProviderId: parentId, settings })
    .where(eq(providers.id, fixture.providerId));
  return parentId;
}

describe("organization writes are gone", () => {
  it.each([
    [
      "POST /v1/providers",
      () => collection.POST(request(fixture.secret, "", "POST", { adapter: "mock", name: "secondary", credentials: {} })),
      async () => expect(await db.select().from(providers).where(eq(providers.name, "secondary"))).toEqual([]),
    ],
    [
      "PATCH /v1/providers/:id",
      () =>
        call(
          one.PATCH,
          request(fixture.secret, `/${fixture.providerId}`, "PATCH", { name: "renamed", credentials: { serverToken: "stolen" } }),
          fixture.providerId,
        ),
      async () => {
        expect((await rowOf(fixture.providerId))?.name).toBe("primary");
        expect(await db.select().from(activity)).toEqual([]);
      },
    ],
    [
      "DELETE /v1/providers/:id",
      () => call(one.DELETE, request(fixture.secret, `/${fixture.providerId}`, "DELETE"), fixture.providerId),
      async () => expect(await rowOf(fixture.providerId)).toBeDefined(),
    ],
  ])("answers %s with 405 and changes nothing", async (_route, send, unchanged) => {
    const response = await send();
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(405);
    expect(body.error.code).toBe("method_not_allowed");
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    await unchanged();
  });

  it("serves only GET on both routes", () => {
    for (const route of [collection, one]) {
      for (const verb of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        expect(route[verb].name, verb).toBe("rejected");
      }
    }
  });

  it("has no test route, so the path falls through to the API's 404", async () => {
    expect(existsSync(join(process.cwd(), "app/api/v1/providers/[id]/test/route.ts"))).toBe(false);

    const response = await unmatched(request(fixture.secret, `/${fixture.providerId}/test`, "POST"));
    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorBody).error.code).toBe("not_found");
  });
});

describe("GET /v1/providers", () => {
  it("lists the organization's providers", async () => {
    const response = await collection.GET(request(fixture.secret, ""));
    const body = (await response.json()) as { data: OrganizationProvider[]; next_cursor: string | null };

    expect(response.status).toBe(200);
    expect(body.data.map((provider) => provider.id)).toEqual([fixture.providerId]);
  });

  it("refuses a scoped key", async () => {
    const scoped = await seedFixture();
    const response = await collection.GET(request(scoped.secret, ""));
    expect(response.status).toBe(403);
  });

  it("ignores a cursor that names another organization's provider", async () => {
    const other = await seedFixture({ scopeToDomain: false });
    await addProvider(fixture, { providerAdapter: "mock", name: "second" });

    const body = (await (await collection.GET(request(fixture.secret, `?cursor=${other.providerId}`))).json()) as {
      data: OrganizationProvider[];
    };

    expect(body.data).toHaveLength(2);
  });

});

describe("GET /v1/providers/:id", () => {
  it("returns exactly the organization fields", async () => {
    await db.update(organizations).set({ providerId: fixture.providerId }).where(eq(organizations.id, fixture.organizationId));
    const body = await readOne(fixture.providerId);

    expect(Object.keys(body).sort()).toEqual(["adapter", "assigned", "backoff_until", "created_at", "id", "name", "status", "updated_at"]);
    expect(body).toMatchObject({ id: fixture.providerId, adapter: "mock", name: "primary", assigned: true, status: "ready" });
  });

  it("refuses a scoped key", async () => {
    const scoped = await seedFixture();
    const response = await one.GET(request(scoped.secret, `/${scoped.providerId}`), routeContext(scoped.providerId));
    expect(response.status).toBe(403);
  });

  it("404s an id from another organization", async () => {
    const other = await seedFixture({ scopeToDomain: false });
    const response = await one.GET(request(fixture.secret, `/${other.providerId}`), routeContext(other.providerId));
    expect(response.status).toBe(404);
  });
});

describe("assigned and status", () => {
  it("marks only the organization's default as assigned", async () => {
    const { providerId } = await addProvider(fixture, { providerAdapter: "mock", name: "other" });
    await db.update(organizations).set({ providerId }).where(eq(organizations.id, fixture.organizationId));

    expect((await readOne(providerId)).assigned).toBe(true);
    expect((await readOne(fixture.providerId)).assigned).toBe(false);
  });

  it("reads setting_up for a tenant with a domain until its event setup is finished, then ready", async () => {
    await makeTenant({ tenantName: "org-x" });
    expect((await readOne(fixture.providerId)).status).toBe("setting_up");

    const { mockConfigured: _configured, ...unfinished } = TENANT_SETTINGS;
    await db.update(providers).set({ settings: unfinished }).where(eq(providers.id, fixture.providerId));
    expect((await readOne(fixture.providerId)).status).toBe("setting_up");

    await db.update(providers).set({ settings: TENANT_SETTINGS }).where(eq(providers.id, fixture.providerId));
    expect((await readOne(fixture.providerId)).status).toBe("ready");
  });

  it("reads ready for a tenant with no domains", async () => {
    const { providerId } = await addProvider(fixture, { providerAdapter: "mock", name: "empty" });
    const parentId = await makeTenant(TENANT_SETTINGS);
    await db.update(providers).set({ sharedProviderId: null }).where(eq(providers.id, fixture.providerId));
    await db
      .update(providers)
      .set({ sharedProviderId: parentId, settings: { tenantName: "org-x" } })
      .where(eq(providers.id, providerId));

    expect((await readOne(providerId)).status).toBe("ready");
  });

  it("reads paused while the provider backs off, and for a tenant under a provider suspension", async () => {
    await db
      .update(providers)
      .set({ backoffUntil: new Date(Date.now() + 60_000) })
      .where(eq(providers.id, fixture.providerId));
    expect((await readOne(fixture.providerId)).status).toBe("paused");

    await db.update(providers).set({ backoffUntil: null }).where(eq(providers.id, fixture.providerId));
    await makeTenant(TENANT_SETTINGS);
    await db
      .update(organizations)
      .set({ suspendedAt: new Date(), suspendSource: "provider", suspendReason: "Paused." })
      .where(eq(organizations.id, fixture.organizationId));
    expect((await readOne(fixture.providerId)).status).toBe("paused");
  });

  it("reads unavailable when the last health check failed, without the provider's text", async () => {
    process.env.REDIS_URL = testRedisUrl();
    await recordProviderProbe(fixture.providerId, "mock", { ok: false, detail: "InvalidClientTokenId from AWS" });

    const raw = await (await one.GET(request(fixture.secret, `/${fixture.providerId}`), routeContext(fixture.providerId))).text();
    expect((JSON.parse(raw) as OrganizationProvider).status).toBe("unavailable");
    expect(raw).not.toContain("InvalidClientTokenId");
  });
});
