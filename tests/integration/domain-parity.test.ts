import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, apiKeys, domains, providers } from "@/lib/db/schema";
import { userActor } from "@/lib/activity/record";
import { generateKeySecret } from "@/lib/api/keys";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { readDomain as readDomainScreen } from "@/lib/dashboard/domains";
import { setDomainLayout, type DomainCaller } from "@/lib/domains";
import { stallStateFor } from "@/lib/domains/stall";
import { newId } from "@/lib/ids";
import { GET as listDomains } from "@/app/api/v1/domains/route";
import { GET as read, PATCH as patch } from "@/app/api/v1/domains/[id]/route";
import { GET as listKeys } from "@/app/api/v1/keys/route";
import { addDomainKey, apiRequest, resetDatabase, routeContext, seedFixture, type Fixture } from "./fixtures";

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
});

const session = (organizationId: string): DomainCaller => ({ organizationId, domainIds: [], actor: userActor("u_test", "Test") });

async function readJson(query = ""): Promise<Record<string, unknown>> {
  const response = await read(apiRequest(fixture.secret, `/v1/domains/${fixture.domainId}${query}`), routeContext(fixture.domainId));
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function patchLayout(layout: unknown): Promise<Response> {
  return patch(apiRequest(fixture.secret, `/v1/domains/${fixture.domainId}`, "PATCH", { layout }), routeContext(fixture.domainId));
}

async function layoutChanges(): Promise<number> {
  const rows = await db
    .select()
    .from(activity)
    .where(and(eq(activity.appliesTo, fixture.domainId), eq(activity.action, "domain.layout.changed")));
  return rows.length;
}

const LAYOUT = { name: "Scope", logo: "https://scope.example/mark.png", accent: "#1d46f5", footer: "Scope · Portland, OR" };

describe("provider_id on a domain", () => {
  it("names the provider the domain sends through now, apart from a pending move", async () => {
    const body = await readJson();
    expect(body.provider_id).toBe(fixture.providerId);
    expect(body.pending).toBeNull();
  });
});

describe("a domain's layout", () => {
  it("reads null until one is set, then reads back what was written", async () => {
    expect((await readJson()).layout).toBeNull();

    const response = await patchLayout(LAYOUT);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { layout: unknown }).layout).toEqual(LAYOUT);
    expect((await readJson()).layout).toEqual(LAYOUT);
    expect(await layoutChanges()).toBe(1);
  });

  it("keeps the fields a patch leaves out, and records nothing for a patch that changes nothing", async () => {
    await patchLayout(LAYOUT);
    await patchLayout({ accent: "#000000", logo: null });
    expect((await readJson()).layout).toEqual({ ...LAYOUT, accent: "#000000", logo: null });

    await patchLayout({ accent: "#000000" });
    expect(await layoutChanges()).toBe(2);
  });

  it("refuses a partial layout on a domain without one, naming the field", async () => {
    const response = await patchLayout({ accent: "#000000" });
    expect(response.status).toBe(422);
    const { error } = (await response.json()) as { error: { code: string; field: string; message: string } };
    expect(error).toMatchObject({ code: "validation_failed", field: "layout.name" });
    expect(error.message).toBe('Field "layout.name" is required.');
    expect((await readJson()).layout).toBeNull();
  });

  it("refuses what the dashboard refuses", async () => {
    for (const [bad, field] of [
      [{ ...LAYOUT, accent: "blue" }, "layout.accent"],
      [{ ...LAYOUT, logo: "http://scope.example/mark.png" }, "layout.logo"],
      [{ ...LAYOUT, footer: "  " }, "layout.footer"],
    ] as const) {
      const response = await patchLayout(bad);
      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: { field: string } }).error.field).toBe(field);
    }
    // The capability the dashboard action calls refuses the same values.
    await expect(setDomainLayout(session(fixture.organizationId), fixture.domainId, { ...LAYOUT, accent: "blue" })).rejects.toMatchObject({
      code: "validation_failed",
      field: "layout.accent",
    });
  });

  it("clears on null, and records that it did", async () => {
    await patchLayout(LAYOUT);
    expect((await patchLayout(null)).status).toBe(200);
    expect((await readJson()).layout).toBeNull();
    const rows = await db
      .select()
      .from(activity)
      .where(and(eq(activity.appliesTo, fixture.domainId), eq(activity.action, "domain.layout.changed")));
    expect(rows.map((row) => row.metadata)).toContainEqual({ cleared: true });
    expect(rows).toHaveLength(2);
  });

  it("is what the dashboard reads", async () => {
    await patchLayout(LAYOUT);
    const screen = await readDomainScreen(session(fixture.organizationId), fixture.domainId);
    expect(screen?.layout).toEqual({ brandName: LAYOUT.name, logoUrl: LAYOUT.logo, accent: LAYOUT.accent, footer: LAYOUT.footer });
  });
});

describe("include=reputation", () => {
  it("is left out by default and added on request", async () => {
    expect(await readJson()).not.toHaveProperty("reputation");

    const body = await readJson("?include=reputation");
    const reputation = body.reputation as Record<string, unknown>;
    expect(Object.keys(reputation)).toEqual(["findings", "windows", "reasons", "signals", "blocklists", "provider_findings", "tenant_volume"]);
    expect((reputation.windows as { days: number }[]).map((window) => window.days)).toEqual([7, 30]);
    expect((reputation.blocklists as { lists: { list: string }[] }).lists.map((entry) => entry.list)).toEqual(["dbl", "zrd"]);
    expect(reputation.tenant_volume).toBeNull();
    expect(body.standing).toBe("healthy");
  });

  it("returns only the id and the detail when fields names it", async () => {
    expect(Object.keys(await readJson("?fields=reputation"))).toEqual(["id", "reputation"]);
  });

  it("is null until the domain has verified", async () => {
    await db.update(domains).set({ status: "pending", verifiedAt: null }).where(eq(domains.id, fixture.domainId));
    expect((await readJson("?include=reputation")).reputation).toBeNull();
  });

  it("is a single read's expansion, not the list's", async () => {
    const response = await listDomains(apiRequest(fixture.secret, "/v1/domains?include=reputation"));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { field: string } }).error.field).toBe("include");
  });
});

describe("setup steps", () => {
  async function both(): Promise<[unknown, unknown]> {
    const screen = await readDomainScreen(session(fixture.organizationId), fixture.domainId);
    return [(await readJson()).setup, screen?.setup];
  }

  it("leave a console step to an admin, on the API and the screen alike", async () => {
    await db.update(providers).set({ adapter: "mailpace" }).where(eq(providers.id, fixture.providerId));
    const [api, screen] = await both();
    expect(api).toEqual(screen);
    expect(api).toEqual([
      { step: "webhooks", message: "Event delivery: waiting on an admin." },
      { step: "credentials", message: "Sending credential: waiting on an admin." },
      { step: "removal", message: "Deleting this domain here won't remove it from the provider. An admin removes it there." },
    ]);
  });

  it("keep the verify step a caller can take", async () => {
    await db
      .update(providers)
      .set({ adapter: "ses", settings: { configurationSetName: "set" } })
      .where(eq(providers.id, fixture.providerId));
    const [api, screen] = await both();
    expect(api).toEqual(screen);
    expect(api).toEqual([{ step: "webhooks", message: "Event delivery isn't set up yet. Verify this domain to finish it." }]);
  });

  it("are empty for an adapter the registry no longer has, rather than failing the read", async () => {
    await db.update(providers).set({ adapter: "retired" }).where(eq(providers.id, fixture.providerId));
    const [api, screen] = await both();
    expect(api).toEqual([]);
    expect(screen).toEqual([]);
  });
});

describe("a stall without its numbers", () => {
  it("reads as stalled everywhere the send loop holds it", async () => {
    const stalledAt = new Date();
    await db.update(domains).set({ stalledAt, stallReason: "bounce_rate", stallDetail: null }).where(eq(domains.id, fixture.domainId));

    expect((await stallStateFor([fixture.domainId])).has(fixture.domainId)).toBe(true);
    expect((await readJson()).stall).toEqual({ reason: "bounce_rate", message: "This domain is paused.", stalled_at: stalledAt.toISOString() });
    expect((await readDomainScreen(session(fixture.organizationId), fixture.domainId))?.stall?.summary).toBe("This domain is paused.");
  });
});

describe("GET /v1/keys?domain=", () => {
  it("lists the keys that reach the domain: limited to it, or to none", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    const third = await addDomainKey(fixture, "third.example.com");
    const generated = generateKeySecret("live");
    const limitedToBoth = newId("key");
    await db.insert(apiKeys).values({
      id: limitedToBoth,
      organizationId: fixture.organizationId,
      name: "both",
      secretHash: generated.secretHash,
      secretPrefix: generated.secretPrefix,
      mode: "live",
      domainIds: [second.domainId, third.domainId],
    });

    const response = await listKeys(apiRequest(fixture.secret, `/v1/keys?domain=${second.domainId}&fields=id`));
    expect(response.status).toBe(200);
    const ids = ((await response.json()) as { data: { id: string }[] }).data.map((key) => key.id).sort();
    // The fixture's key is limited to no domain.
    expect(ids).toEqual([fixture.key.id, second.key.id, limitedToBoth].sort());
  });
});
