import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The decrypt path, spied at the adapter boundary so every caller is covered — including
 * decryptCredentials and adapterFor, which call it from inside lib/providers.
 */
vi.mock("@/lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto")>();
  return { ...actual, decrypt: vi.fn(actual.decrypt) };
});

// SES rows get a stub provider, so the admin routes below never reach AWS.
vi.mock("@/lib/providers/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/adapters")>();
  const buildAdapter: typeof actual.buildAdapter = (adapter, ...rest) => {
    if (adapter !== "ses") return actual.buildAdapter(adapter, ...rest);
    return {
      healthCheck: async () => ({ ok: true, detail: null }),
      domain: {
        create: async (name: string) => ({ providerDomainId: name, records: [] }),
        adopt: async (name: string) => ({ providerDomainId: name, records: [], sending: true, dkimTokens: ["tok1"], existingMailFromDomain: null }),
        verify: async () => ({ answered: true, verified: true, missing: [], errors: [] }),
      },
      setup: { isConfigured: () => true, configureEvents: async () => ({ settings: {} }), teardown: async () => {} },
      conversion: { calls: () => [], permissions: () => ["ses:CreateTenant"], missingPermissions: async () => ["ses:CreateTenant"] },
    } as unknown as ReturnType<typeof actual.buildAdapter>;
  };
  return { ...actual, buildAdapter };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, organizations, providers } from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto";
import { listDomains as listDomainsForDashboard, readDomain as readDomainForDashboard } from "@/lib/dashboard/domains";
import { readSendingProvider } from "@/lib/dashboard/service";
import { listKeys } from "@/lib/dashboard/keys";
import { listMessages, readMessage } from "@/lib/dashboard/messages";
import { listSuppressions } from "@/lib/dashboard/suppressions";
import { listDomains, readDomain } from "@/lib/domains";
import { userActor } from "@/lib/activity/record";
import { newId } from "@/lib/ids";
import { ROUTES } from "@/lib/api-docs/spec";
import { ROLES } from "@/lib/auth/permissions";
import { MCP_TOOLS } from "@/lib/mcp/registry";
import { encryptCredentials } from "@/lib/providers";
import { planConversion } from "@/lib/providers/convert";
import { callRoute, seedAdmin, seedSharedSes, SES_CREDENTIALS, SES_SECRET } from "./admin-fixtures";
import { resetDatabase, seedFixture, seedSystemOrganization, seedUser, type Fixture } from "./fixtures";

const decrypted = vi.mocked(decrypt);

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  decrypted.mockClear();
});

/** A dashboard session: the organization, and no domain scope. */
const session = (organizationId: string) => ({ organizationId, domainIds: [] as string[], actor: userActor("u_test", "Test") });

/**
 * Reading a screen must never decrypt a provider's credentials. Nothing leaks today,
 * but a page that pulls a live provider secret into memory on every view is one careless log
 * or error serialization away from being the leak. Sending, verifying and receiving events
 * genuinely need the secret; drawing a screen does not.
 */
describe("drawing a screen", () => {
  it("never decrypts credentials to render the domain detail", async () => {
    const domain = await readDomainForDashboard(session(fixture.organizationId), fixture.domainId);
    expect(domain).not.toBeNull();
    expect(decrypted).not.toHaveBeenCalled();
  });

  it("never decrypts credentials on a domain whose events aren't set up yet", async () => {
    // The unfinished case is the one that used to build an Adapter to find out.
    await db
      .update(providers)
      .set({ adapter: "ses", settings: { configurationSetName: "set" } })
      .where(eq(providers.id, fixture.providerId));

    const domain = await readDomainForDashboard(session(fixture.organizationId), fixture.domainId);
    expect(domain?.setup.some((step) => step.step === "webhooks")).toBe(true);
    expect(decrypted).not.toHaveBeenCalled();
  });

  it("never decrypts credentials for any other dashboard read", async () => {
    await db.update(organizations).set({ providerId: fixture.providerId }).where(eq(organizations.id, fixture.organizationId));
    await Promise.all([
      listDomainsForDashboard(fixture.organizationId, "UTC"),
      readSendingProvider(fixture.organizationId).then((sending) => expect(sending).not.toBeNull()),
      listKeys(fixture.organizationId, "UTC"),
      listMessages(fixture.organizationId),
      listSuppressions(fixture.organizationId),
    ]);
    await readMessage(fixture.organizationId, "msg_missing");

    expect(decrypted).not.toHaveBeenCalled();
  });

  it("never decrypts credentials to answer the domains API", async () => {
    await listDomains(session(fixture.organizationId), 50);
    await readDomain(session(fixture.organizationId), fixture.domainId);

    expect(decrypted).not.toHaveBeenCalled();
  });

  it("never decrypts credentials to plan a conversion", async () => {
    await seedSystemOrganization();
    await db
      .update(providers)
      .set({ adapter: "ses", providerIdentity: "111122223333", settings: { configurationSetName: "set", topicArn: "arn" } })
      .where(eq(providers.id, fixture.providerId));

    const plan = await planConversion(fixture.providerId);

    expect(plan.permissions).toContain("ses:CreateTenant");
    expect(plan.stages.find((stage) => stage.stage === "tenant")?.calls).not.toEqual([]);
    expect(decrypted).not.toHaveBeenCalled();
  });

  it("still decrypts where the provider is actually called", async () => {
    // The guard is "not to draw a screen", not "never" — this keeps it honest.
    const { adapterFor } = await import("@/lib/providers");
    const [provider] = await db
      .select()
      .from(providers)
      .where(eq(providers.id, fixture.providerId))
      .limit(1);

    adapterFor(provider!);
    expect(decrypted).toHaveBeenCalledTimes(1);
  });

  it("reports the same setup state the provider would, without asking it", async () => {
    await db
      .update(providers)
      .set({
        adapter: "ses",
        settings: { configurationSetName: "set", topicArn: "arn", subscriptionConfirmed: "true" },
      })
      .where(eq(providers.id, fixture.providerId));
    await db.update(domains).set({ name: "example.com" }).where(eq(domains.id, fixture.domainId));

    const domain = await readDomainForDashboard(session(fixture.organizationId), fixture.domainId);
    // Fully configured SES leaves nothing for the console.
    expect(domain?.setup).toEqual([]);
    expect(decrypted).not.toHaveBeenCalled();
  });
});

describe("the admin API", () => {
  const NEW_SECRET = "new-secret-do-not-leak";
  const ROTATED_SECRET = "rotated-secret-do-not-leak";
  const MOCK_SECRET = "mock-secret-do-not-leak";

  it("never returns credentials from any admin route, and reads never decrypt them", async () => {
    const admin = await seedAdmin();
    const org = await seedFixture({ scopeToDomain: false, credentials: { serverToken: MOCK_SECRET } });
    const shared = await seedSharedSes();
    const bare = newId("organization");
    await db.insert(organizations).values({ id: bare, name: "Bare", slug: `bare-${bare}` });
    const legacy = newId("provider");
    await db.insert(providers).values({
      id: legacy,
      organizationId: org.organizationId,
      adapter: "ses",
      name: "legacy",
      credentials: encryptCredentials(SES_CREDENTIALS),
      providerIdentity: "111122223333",
      settings: { configurationSetName: "set", topicArn: "arn:aws:sns:us-west-2:111122223333:t" },
    });
    const ciphertexts = (await db.select({ credentials: providers.credentials }).from(providers)).map((row) => row.credentials);

    const bodies: string[] = [];
    const called = new Set<string>();
// Response bodies are asserted on loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function run(name: string, args: Record<string, unknown>): Promise<any> {
      const tool = MCP_TOOLS.find((entry) => entry.name === name)!;
      decrypted.mockClear();
      const response = await callRoute(tool, admin.secret, args);
      const text = await response.text();
      expect({ name, status: response.status < 300 ? "ok" : text }).toEqual({ name, status: "ok" });
      if (tool.route.method === "GET") expect({ name, decrypted: decrypted.mock.calls.length }).toEqual({ name, decrypted: 0 });
      bodies.push(text);
      called.add(`${tool.route.method} ${tool.route.path}`);
      return JSON.parse(text);
    }

    await run("adopt_admin_domain", { organization_id: org.organizationId, name: "adopted.example.com", provider_id: legacy });
    await run("list_admin_providers", {});
    await run("read_admin_provider", { id: shared });
    const created = await run("create_admin_provider", {
      adapter: "ses",
      name: "New",
      credentials: { ...SES_CREDENTIALS, secretAccessKey: NEW_SECRET },
    });
    await run("update_admin_provider", { id: shared, credentials: { ...SES_CREDENTIALS, secretAccessKey: ROTATED_SECRET } });
    await run("test_admin_provider", { id: shared });
    await run("setup_admin_provider", { id: shared });
    await run("convert_admin_provider", { id: legacy });
    await vi.waitFor(async () => {
      const status = await run("read_admin_conversion", { id: legacy });
      expect(status?.conversion?.state).toBe("failed");
    });
    await run("list_provider_organizations", { id: shared });
    await run("assign_organization", { id: shared, organization_id: bare });
    await run("list_provider_organizations", { id: shared });
    await run("unassign_organization", { id: shared, organizationId: bare });
    await run("delete_admin_provider", { id: created.id });
    await run("list_admin_organizations", {});
    await run("read_admin_organization", { id: org.organizationId });
    await run("update_admin_organization", { id: org.organizationId, provider_id: org.providerId });
    await run("suspend_organization", { id: org.organizationId, reason: "Checking." });
    await run("release_organization", { id: org.organizationId });

    const newOrganization = await run("create_admin_organization", { name: "Hygiene" });
    const leaving = await seedUser({ organizationId: newOrganization.id, role: ROLES.MEMBER });
    await run("list_organization_members", { id: newOrganization.id });
    await run("update_organization_member", { id: newOrganization.id, userId: leaving.userId, role: ROLES.OWNER });
    await run("remove_organization_member", { id: newOrganization.id, userId: leaving.userId });
    const invitation = await run("invite_to_organization", { id: newOrganization.id, email: "invited@example.com" });
    await run("list_organization_invitations", { id: newOrganization.id });
    await run("resend_organization_invitation", { id: newOrganization.id, invitationId: invitation.id });
    await run("revoke_organization_invitation", { id: newOrganization.id, invitationId: invitation.id });
    await run("list_admin_users", {});
    await run("read_admin_user", { id: admin.adminUserId });
    await run("update_admin_user", { id: leaving.userId, admin: true });
    await run("delete_admin_user", { id: leaving.userId });
    await run("delete_admin_organization", { id: newOrganization.id });

    const adminRoutes = ROUTES.filter((route) => route.path.startsWith("/v1/admin/")).map((route) => `${route.method} ${route.path}`);
    expect([...called].sort()).toEqual(adminRoutes.sort());

    const all = bodies.join("\n");
    for (const secret of [SES_SECRET, NEW_SECRET, ROTATED_SECRET, MOCK_SECRET, SES_CREDENTIALS.accessKeyId, ...ciphertexts]) {
      expect(all).not.toContain(secret);
    }
    expect(all).not.toMatch(/"credentials"\s*:/);
  });
});
