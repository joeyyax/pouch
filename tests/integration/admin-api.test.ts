import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

const { sesCalls, sesIdentities } = vi.hoisted(() => ({ sesCalls: [] as string[], sesIdentities: new Set<string>() }));

// SES rows get a stub provider, so nothing here reaches AWS.
vi.mock("@/lib/providers/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/adapters")>();
  const { DomainNotAtProviderError } = await import("@/lib/providers/adapters/types");
  const buildAdapter: typeof actual.buildAdapter = (adapter, ...rest) => {
    if (adapter !== "ses") return actual.buildAdapter(adapter, ...rest);
    return {
      domain: {
        adopt: async (name: string) => {
          sesCalls.push(`adopt ${name}`);
          if (!sesIdentities.has(name)) throw new DomainNotAtProviderError(name);
          return { providerDomainId: name, records: [], sending: true, dkimTokens: ["tok1"], existingMailFromDomain: null };
        },
        verify: async () => ({ answered: true, verified: true, missing: [], errors: [] }),
      },
      healthCheck: async () => {
        sesCalls.push("healthCheck");
        return { ok: true, detail: null };
      },
      setup: {
        isConfigured: (settings: Record<string, string>) => settings.eventRuleArn === "rebuilt",
        configureEvents: async () => {
          sesCalls.push("configureEvents");
          return { settings: { eventRuleArn: "rebuilt" } };
        },
        teardown: async () => {
          sesCalls.push("teardown");
        },
      },
    } as unknown as ReturnType<typeof actual.buildAdapter>;
  };
  return { ...actual, buildAdapter };
});

import { db } from "@/lib/db";
import { activity, domains, organizations, providers } from "@/lib/db/schema";
import { encryptCredentials } from "@/lib/providers";
import { createApiKey } from "@/lib/api/key-lifecycle";
import { newId } from "@/lib/ids";
import { MCP_TOOLS, type McpToolDefinition } from "@/lib/mcp/registry";
import { callRoute, seedAdmin, seedSharedSes, SES_CREDENTIALS, type AdminFixture } from "./admin-fixtures";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

const ADMIN_TOOLS = MCP_TOOLS.filter((tool) => tool.admin);

function tool(name: string): McpToolDefinition {
  const found = MCP_TOOLS.find((entry) => entry.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

// Response bodies are asserted on loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(name: string, secret: string, args: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
  const response = await callRoute(tool(name), secret, args);
  return { status: response.status, body: await response.json() };
}

async function bareOrganization(name = "Bare"): Promise<string> {
  const id = newId("organization");
  await db.insert(organizations).values({ id, name, slug: `bare-${id}` });
  return id;
}

let admin: AdminFixture;
let org: Fixture;

beforeEach(async () => {
  await resetDatabase();
  sesCalls.length = 0;
  sesIdentities.clear();
  admin = await seedAdmin();
  org = await seedFixture({ scopeToDomain: false });
});

describe("an organization key", () => {
  it("gets admin_key_required from every admin route", async () => {
    const { secret: otherKey } = await createApiKey({ organizationId: admin.organizationId, name: "plain", mode: "live", domainIds: [] });
    expect(ADMIN_TOOLS.length).toBeGreaterThanOrEqual(17);
    for (const secret of [org.secret, otherKey]) {
      for (const entry of ADMIN_TOOLS) {
        const response = await callRoute(entry, secret, { id: org.providerId, organizationId: org.organizationId });
        const body = await response.json();
        expect({ tool: entry.name, status: response.status, code: body.error?.code }).toEqual({
          tool: entry.name,
          status: 403,
          code: "admin_key_required",
        });
      }
    }
    expect(await db.select().from(providers)).toHaveLength(2);
  });
});

describe("providers", () => {
  it("creates a single-organization provider and makes it the default when there's none", async () => {
    const bare = newId("organization");
    await db.insert(organizations).values({ id: bare, name: "Bare", slug: `bare-${bare}` });

    const { status, body } = await call("create_admin_provider", admin.secret, {
      adapter: "mock",
      name: "Solo",
      credentials: { token: "never-returned" },
      organization_id: bare,
      concurrency: 7,
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ adapter: "mock", name: "Solo", kind: "single", organization_id: bare, concurrency: 7, credentials_verified: true });
    expect(JSON.stringify(body)).not.toContain("never-returned");
    expect(body).not.toHaveProperty("credentials");

    const [row] = await db.select().from(organizations).where(eq(organizations.id, bare));
    expect(row?.providerId).toBe(body.id);

    const mirrored = await db
      .select()
      .from(activity)
      .where(and(isNull(activity.organizationId), eq(activity.appliesTo, body.id)));
    expect(mirrored.map((entry) => entry.action)).toEqual(["provider.created"]);
  });

  it("refuses a single-organization adapter without organization_id, and SES with one", async () => {
    const single = await call("create_admin_provider", admin.secret, { adapter: "mock", name: "X", credentials: {} });
    expect(single.status).toBe(422);
    expect(single.body.error).toMatchObject({ code: "validation_failed", field: "organization_id" });

    const ses = await call("create_admin_provider", admin.secret, {
      adapter: "ses",
      name: "X",
      credentials: SES_CREDENTIALS,
      organization_id: org.organizationId,
    });
    expect(ses.status).toBe(422);
    expect(ses.body.error.field).toBe("organization_id");
  });

  it("creates a shared SES account with no organization and runs its setup", async () => {
    const { status, body } = await call("create_admin_provider", admin.secret, {
      adapter: "ses",
      name: "Customers",
      credentials: SES_CREDENTIALS,
      concurrency: 12,
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ kind: "shared", organization_id: null, organization_count: 0, concurrency: 12, credentials_verified: true });
    expect(sesCalls).toEqual(["healthCheck", "configureEvents"]);
    const [row] = await db.select().from(providers).where(eq(providers.id, body.id));
    expect(row).toMatchObject({ shared: true, organizationId: null });
  });

  it("lists every provider newest first, pages them, and filters to the ones needing attention", async () => {
    const shared = await seedSharedSes();
    const legacy = newId("provider");
    await db.insert(providers).values({
      id: legacy,
      organizationId: org.organizationId,
      adapter: "ses",
      name: "legacy",
      credentials: encryptCredentials(SES_CREDENTIALS),
    });

    const all = await call("list_admin_providers", admin.secret, {});
    const ids = all.body.data.map((provider: { id: string }) => provider.id);
    expect(ids.slice(0, 2)).toEqual([legacy, shared]);
    expect(ids).toContain(org.providerId);

    const first = await call("list_admin_providers", admin.secret, { limit: 1 });
    expect(first.body.data.map((provider: { id: string }) => provider.id)).toEqual([legacy]);
    const second = await call("list_admin_providers", admin.secret, { limit: 1, cursor: first.body.next_cursor });
    expect(second.body.data.map((provider: { id: string }) => provider.id)).toEqual([shared]);

    const attention = await call("list_admin_providers", admin.secret, { status: "attention" });
    const flagged = attention.body.data.map((provider: { id: string }) => provider.id);
    expect(flagged).toContain(legacy);
    expect(flagged).not.toContain(shared);
    expect(attention.body.data[0]).toMatchObject({ id: legacy, status: "needs_conversion" });
    expect(attention.body.data[0].issues[0]).toBe("needs_conversion");

    const bad = await call("list_admin_providers", admin.secret, { cursor: "pac_missing" });
    expect(bad.body.error).toMatchObject({ code: "validation_failed", field: "cursor" });
  });

  it("doesn't treat an assignment row as a provider", async () => {
    const shared = await seedSharedSes();
    const assigned = await call("assign_organization", admin.secret, { id: shared, organization_id: await bareOrganization() });
    expect(assigned.status).toBe(201);
    const { status } = await call("read_admin_provider", admin.secret, { id: assigned.body.provider_id });
    expect(status).toBe(404);
  });

  it("renames a shared provider, gives its tenants the new concurrency and marks it for new organizations", async () => {
    const shared = await seedSharedSes();
    const assigned = await call("assign_organization", admin.secret, { id: shared, organization_id: await bareOrganization() });

    const { status, body } = await call("update_admin_provider", admin.secret, {
      id: shared,
      name: "Renamed",
      concurrency: 9,
      default_for_new_organizations: true,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: "Renamed", concurrency: 9, default_for_new_organizations: true });
    expect(body).not.toHaveProperty("credentials_verified");

    const [tenant] = await db.select().from(providers).where(eq(providers.id, assigned.body.provider_id));
    expect(tenant?.concurrency).toBe(9);

    const settings = await call("update_admin_provider", admin.secret, { id: shared, settings: { topicArn: "x" } });
    expect(settings.body.error).toMatchObject({ code: "validation_failed", field: "settings" });
  });

  it("rotates a shared provider's credentials into every assignment row", async () => {
    const shared = await seedSharedSes();
    const assigned = await call("assign_organization", admin.secret, { id: shared, organization_id: await bareOrganization() });
    const [before] = await db.select().from(providers).where(eq(providers.id, assigned.body.provider_id));

    const { status, body } = await call("update_admin_provider", admin.secret, {
      id: shared,
      credentials: { ...SES_CREDENTIALS, secretAccessKey: "rotated-secret" },
    });
    expect(status).toBe(200);
    expect(body.credentials_verified).toBe(true);
    expect(JSON.stringify(body)).not.toContain("rotated-secret");

    const [after] = await db.select().from(providers).where(eq(providers.id, assigned.body.provider_id));
    const [parent] = await db.select().from(providers).where(eq(providers.id, shared));
    expect(after?.credentials).not.toBe(before?.credentials);
    expect(after?.credentials).toBe(parent?.credentials);
  });

  it("refuses to make a single-organization provider the default for new organizations", async () => {
    const { body } = await call("update_admin_provider", admin.secret, { id: org.providerId, default_for_new_organizations: true });
    expect(body.error).toMatchObject({ code: "validation_failed", field: "default_for_new_organizations" });
  });

  it("refuses to delete a shared provider while an organization holds it", async () => {
    const shared = await seedSharedSes();
    const bare = await bareOrganization();
    await call("assign_organization", admin.secret, { id: shared, organization_id: bare });

    const refused = await call("delete_admin_provider", admin.secret, { id: shared });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "provider_in_use", detail: { organizations: [bare] } });

    const unassigned = await call("unassign_organization", admin.secret, { id: shared, organizationId: bare });
    expect(unassigned.body).toEqual({ provider_id: shared, organization_id: bare, unassigned: true });
    expect(sesCalls).toEqual(["teardown"]);

    const deleted = await call("delete_admin_provider", admin.secret, { id: shared });
    expect(deleted.body).toEqual({ id: shared, deleted: true });
  });

  it("refuses to delete a single-organization provider with domains bound", async () => {
    const { status, body } = await call("delete_admin_provider", admin.secret, { id: org.providerId });
    expect(status).toBe(422);
    expect(body.error.code).toBe("provider_in_use");
  });

  it("tests a provider live and reports the verdict", async () => {
    const { status, body } = await call("test_admin_provider", admin.secret, { id: org.providerId });
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: org.providerId, ok: true, throttled: false });
  });

  it("runs setup again", async () => {
    const shared = await seedSharedSes();
    const { status, body } = await call("setup_admin_provider", admin.secret, { id: shared });
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: shared, configured: true, settings: { eventRuleArn: "rebuilt" } });
    expect(sesCalls).toEqual(["configureEvents"]);
  });

  it("refuses to convert a provider that has no tenants to convert into", async () => {
    const { status, body } = await call("convert_admin_provider", admin.secret, { id: org.providerId });
    expect(status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
  });
});

describe("adopting a domain", () => {
  it("adopts an identity the provider already holds, for one organization", async () => {
    const target = await seedFixture({ scopeToDomain: false, providerAdapter: "ses" });
    sesIdentities.add("adopted.example.com");

    const { status, body } = await call("adopt_admin_domain", admin.secret, {
      organization_id: target.organizationId,
      name: "adopted.example.com",
      provider_id: target.providerId,
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ name: "adopted.example.com", adopted: true, status: "verified" });
    expect(sesCalls).toContain("adopt adopted.example.com");
    const [logged] = await db.select().from(activity).where(eq(activity.action, "domain.adopted"));
    expect(logged?.organizationId).toBe(target.organizationId);
  });

  it("refuses a domain the provider has no identity for", async () => {
    const target = await seedFixture({ scopeToDomain: false, providerAdapter: "ses" });

    const { status, body } = await call("adopt_admin_domain", admin.secret, {
      organization_id: target.organizationId,
      name: "nothing.example.com",
      provider_id: target.providerId,
    });

    expect(status).toBe(422);
    expect(body.error.code).toBe("domain_not_at_provider");
  });

  it("refuses an adapter that has nothing to adopt", async () => {
    const { status, body } = await call("adopt_admin_domain", admin.secret, {
      organization_id: org.organizationId,
      name: "adopted.example.com",
      provider_id: org.providerId,
    });

    expect(status).toBe(422);
    expect(body.error.code).toBe("capability_unavailable");
  });

  it("refuses an organization it doesn't know", async () => {
    const { status, body } = await call("adopt_admin_domain", admin.secret, {
      organization_id: "org_missing",
      name: "adopted.example.com",
    });

    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });
});

describe("assignments", () => {
  it("assigns without a provider call, makes it the default, and returns the same assignment again", async () => {
    const shared = await seedSharedSes();
    const bare = newId("organization");
    await db.insert(organizations).values({ id: bare, name: "Bare", slug: `bare-${bare}` });

    const first = await call("assign_organization", admin.secret, { id: shared, organization_id: bare });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ organization_id: bare, default: true, domain_count: 0, status: "ready" });
    expect(sesCalls).toEqual([]);

    const again = await call("assign_organization", admin.secret, { id: shared, organization_id: bare });
    expect(again.body.provider_id).toBe(first.body.provider_id);

    const listed = await call("list_provider_organizations", admin.secret, { id: shared });
    expect(listed.body).toEqual({ data: [first.body], next_cursor: null });

    const read = await call("read_admin_provider", admin.secret, { id: shared });
    expect(read.body.organization_count).toBe(1);

    const mirrored = await db
      .select()
      .from(activity)
      .where(and(isNull(activity.organizationId), eq(activity.action, "provider.shared.attached")));
    expect(mirrored).toHaveLength(2);
  });

  it("pages a provider's organizations", async () => {
    const shared = await seedSharedSes();
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const id = newId("organization");
      await db.insert(organizations).values({ id, name: `Org ${n}`, slug: `org-${n}-${id}` });
      ids.push(id);
      await call("assign_organization", admin.secret, { id: shared, organization_id: id });
    }
    const first = await call("list_provider_organizations", admin.secret, { id: shared, limit: 2 });
    const second = await call("list_provider_organizations", admin.secret, { id: shared, limit: 2, cursor: first.body.next_cursor });
    const seen = [...first.body.data, ...second.body.data].map((entry: { organization_id: string }) => entry.organization_id);
    expect(seen).toEqual([...ids].reverse());
    expect(second.body.next_cursor).toBeNull();
  });

  it("refuses a second assignment to an organization that already has one", async () => {
    const shared = await seedSharedSes();
    const { status, body } = await call("assign_organization", admin.secret, { id: shared, organization_id: org.organizationId });
    expect(status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
  });

  it("refuses to assign a single-organization provider elsewhere", async () => {
    const other = await seedFixture();
    const { status, body } = await call("assign_organization", admin.secret, { id: org.providerId, organization_id: other.organizationId });
    expect(status).toBe(422);
    expect(body.error).toMatchObject({ code: "validation_failed", field: "organization_id" });
  });

  it("answers 404 for an organization the provider isn't assigned to", async () => {
    const shared = await seedSharedSes();
    const { status } = await call("unassign_organization", admin.secret, { id: shared, organizationId: org.organizationId });
    expect(status).toBe(404);
    expect(sesCalls).toEqual([]);
  });

  it("refuses to unassign while domains are bound", async () => {
    const shared = await seedSharedSes();
    const bare = await bareOrganization();
    const assigned = await call("assign_organization", admin.secret, { id: shared, organization_id: bare });
    await db.insert(domains).values({
      id: newId("domain"),
      organizationId: bare,
      providerId: assigned.body.provider_id,
      name: "bound.example.com",
      status: "pending",
    });
    const { body } = await call("unassign_organization", admin.secret, { id: shared, organizationId: bare });
    expect(body.error.code).toBe("provider_in_use");
    expect(sesCalls).toEqual([]);
  });
});

describe("organizations", () => {
  it("lists and reads organizations with their default provider", async () => {
    const shared = await seedSharedSes();
    const bare = newId("organization");
    await db.insert(organizations).values({ id: bare, name: "Bare", slug: `bare-${bare}` });
    const assigned = await call("assign_organization", admin.secret, { id: shared, organization_id: bare });

    const listed = await call("list_admin_organizations", admin.secret, { limit: 2 });
    expect(listed.body.data.map((entry: { id: string }) => entry.id)).toEqual([bare, org.organizationId]);
    expect(listed.body.next_cursor).toBe(org.organizationId);
    const rest = await call("list_admin_organizations", admin.secret, { cursor: listed.body.next_cursor });
    expect(rest.body.data).toEqual([expect.objectContaining({ id: admin.organizationId })]);

    const read = await call("read_admin_organization", admin.secret, { id: bare });
    expect(read.body).toMatchObject({
      provider_id: assigned.body.provider_id,
      managed_provider_id: shared,
      assignment_count: 1,
      domain_count: 0,
      suspension: null,
    });
  });

  it("sets the default only to one of the organization's assignments", async () => {
    const other = await seedFixture();
    const foreign = await call("update_admin_organization", admin.secret, { id: org.organizationId, provider_id: other.providerId });
    expect(foreign.status).toBe(404);

    const own = await call("update_admin_organization", admin.secret, { id: org.organizationId, provider_id: org.providerId });
    expect(own.body).toMatchObject({ provider_id: org.providerId, managed_provider_id: org.providerId });
  });

  it("suspends manually and releases", async () => {
    const suspended = await call("suspend_organization", admin.secret, { id: org.organizationId, reason: "Spam complaints." });
    expect(suspended.body).toMatchObject({ changed: true, suspension: { source: "manual", reason: "Spam complaints." } });

    const again = await call("suspend_organization", admin.secret, { id: org.organizationId, reason: "Other." });
    expect(again.body).toMatchObject({ changed: false, suspension: { reason: "Spam complaints." } });

    const released = await call("release_organization", admin.secret, { id: org.organizationId });
    expect(released.body).toMatchObject({ changed: true, suspension: null });

    const actions = await db.select({ action: activity.action }).from(activity).where(isNull(activity.organizationId));
    expect(actions.map((entry) => entry.action).sort()).toEqual(["organization.suspended", "organization.suspension.released"]);
  });

  it("needs a reason to suspend", async () => {
    const missing = await call("suspend_organization", admin.secret, { id: org.organizationId });
    expect(missing.body.error).toMatchObject({ code: "validation_failed", field: "reason" });
  });
});
