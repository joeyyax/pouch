/** Admin → Providers and Admin → Organizations (#355, increment 6). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, providers } from "@/lib/db/schema";
import { encryptCredentials } from "@/lib/providers";
import { ConversionStoppedError } from "@/lib/providers/convert";
import { recordProviderProbe } from "@/lib/health/checks";
import { newId } from "@/lib/ids";
import { setDefaultForNewOrganizations } from "@/lib/providers/shared";
import { readDefaultProviderId } from "@/lib/settings/service";
import { closeRedis } from "@/lib/redis";
import { listAdminProviders, readAdminProvider } from "@/lib/dashboard/admin-providers";
import { listOrganizationsForOperator } from "@/lib/dashboard/admin-organizations";
import * as providerActions from "@/app/(app)/admin/settings/providers/actions";
import * as organizationActions from "@/app/(app)/admin/settings/organizations/actions";
import { setDefaultProviderAction } from "@/app/(app)/admin/settings/general/actions";
import ProviderAccountsPage from "@/app/(app)/admin/settings/provider-accounts/page";
import SharedAccountsPage from "@/app/(app)/admin/settings/shared-accounts/page";
import AdminSettingsLayout from "@/app/(app)/admin/settings/layout";
import { form, resetDatabase, seedFixture, seedSystemOrganization, seedUser } from "./fixtures";
import { clearRedisKeys, testRedisUrl } from "../redis";

const sessionState = vi.hoisted(() => ({ userId: null as string | null }));
const convert = vi.hoisted(() => ({ impl: null as null | ((id: string) => Promise<unknown>), calls: [] as { id: string; actor: unknown }[] }));

vi.mock("@/lib/auth/session", async () => (await import("./fixtures")).adminSessionModule(sessionState));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/providers/convert", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/providers/convert")>();
  return {
    ...original,
    convertToTenant: async (id: string, options: { actor: unknown }) => {
      convert.calls.push({ id, actor: options.actor });
      if (!convert.impl) throw new Error("convertToTenant has no stub");
      return convert.impl(id);
    },
  };
});

const idle = { status: "idle" } as const;
let operatorOrganizationId: string;

async function makeUser(admin: boolean, organizationId: string): Promise<string> {
  return (await seedUser({ organizationId, admin, name: admin ? "Olive" : "Mo" })).userId;
}

async function sharedProvider(name: string, options: { isDefault?: boolean } = {}): Promise<string> {
  const id = newId("provider");
  await db.insert(providers).values({
    id,
    adapter: "ses",
    name,
    credentials: encryptCredentials({ accessKeyId: "AKIA", secretAccessKey: "s", region: "us-west-2" }),
    settings: { sharing: "operator", topicArn: "arn:t", subscriptionConfirmed: "true", eventRuleArn: "arn:r" },
    providerIdentity: "111122223333",
    shared: true,
  });
  if (options.isDefault) await setDefaultForNewOrganizations(id);
  return id;
}

async function legacyProvider(organizationId: string): Promise<string> {
  const id = newId("provider");
  await db.insert(providers).values({
    id,
    organizationId,
    adapter: "ses",
    name: "legacy",
    credentials: encryptCredentials({ accessKeyId: "AKIA", secretAccessKey: "s", region: "us-west-2" }),
    settings: { topicArn: "arn:t", subscriptionConfirmed: "true", configurationSetName: `mail-events-${id}` },
    providerIdentity: "111122223333",
  });
  return id;
}

/** Which shared provider the single pointer names, by name. */
async function defaultProviderName(): Promise<string | null> {
  const id = await readDefaultProviderId();
  if (!id) return null;
  const [row] = await db.select({ name: providers.name }).from(providers).where(eq(providers.id, id));
  return row?.name ?? null;
}

beforeEach(async () => {
  await resetDatabase();
  sessionState.userId = null;
  convert.impl = null;
  convert.calls.length = 0;
  ({ organizationId: operatorOrganizationId } = await seedSystemOrganization());
});

afterEach(async () => {
  delete process.env.REDIS_URL;
  await closeRedis();
});

describe("non-admins", () => {
  it("get a 404 from every admin settings page", async () => {
    sessionState.userId = await makeUser(false, operatorOrganizationId);
    await expect(AdminSettingsLayout({ children: null })).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });

  it("are refused by every provider and organization action, and nothing changes", async () => {
    const providerId = await sharedProvider("Hosted");
    const fixture = await seedFixture();
    sessionState.userId = await makeUser(false, fixture.organizationId);
    const fields = form({ id: providerId, organizationId: fixture.organizationId, name: "Sneaky", adapter: "ses", on: "true", sharedProviderId: providerId });

    const actions = [
      ...Object.entries(providerActions),
      ["assignProviderAction", organizationActions.assignProviderAction],
      ["createOrganizationAdminAction", organizationActions.createOrganizationAdminAction],
    ] as [string, unknown][];
    const callable = actions.filter((entry): entry is [string, (state: typeof idle, data: FormData) => Promise<unknown>] => typeof entry[1] === "function");
    expect(callable.map(([name]) => name).sort()).toEqual(
      [
        "adoptDomainAction",
        "assignProviderAction",
        "assignOrganizationAction",
        "convertProviderAction",
        "createProviderAction",
        "createOrganizationAdminAction",
        "deleteProviderAction",
        "renameProviderAction",
        "rotateCredentialsAction",
        "runSetupAction",
        "setWebhookKeyAction",
        "testProviderAction",
        "unassignOrganizationAction",
      ].sort(),
    );
    for (const [name, action] of callable) {
      await expect(action(idle, fields), name).rejects.toThrow("Forbidden");
    }

    expect(await defaultProviderName()).toBeNull();
    expect(convert.calls).toHaveLength(0);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, fixture.organizationId));
    expect(org?.providerId).toBeNull();
    expect(await db.select().from(organizations)).toHaveLength(2);
  });

  it("are refused when signed out", async () => {
    const providerId = await sharedProvider("Hosted");
    await expect(providerActions.renameProviderAction(idle, form({ id: providerId, name: "Nope" }))).rejects.toThrow("Unauthorized");
  });
});

describe("default for new organizations", () => {
  beforeEach(async () => {
    sessionState.userId = await makeUser(true, operatorOrganizationId);
  });

  it("moves to the provider an admin picks, and new organizations get it", async () => {
    const first = await sharedProvider("First", { isDefault: true });
    const second = await sharedProvider("Second");

    const result = await setDefaultProviderAction(idle, form({ providerId: second }));
    expect(result.status).toBe("ok");
    expect(await defaultProviderName()).toBe("Second");
    expect((await listAdminProviders()).filter((provider) => provider.isDefault).map((provider) => provider.id)).toEqual([second]);
    expect((await listOrganizationsForOperator()).defaultProvider).toEqual({ id: second, name: "Second" });

    const created = await organizationActions.createOrganizationAdminAction(idle, form({ name: "Acme", slug: "acme" }));
    expect(created).toEqual({ status: "created", name: "Acme", providerName: "Second" });
    const [acme] = await db.select().from(organizations).where(eq(organizations.slug, "acme"));
    const [tenant] = await db.select().from(providers).where(eq(providers.id, acme!.providerId!));
    expect(tenant?.sharedProviderId).toBe(second);
    const view = (await listOrganizationsForOperator()).organizations.find((org) => org.id === acme!.id);
    expect(view?.provider).toMatchObject({ managedProviderId: second, name: "Second" });
    expect(first).not.toBe(second);
  });

  it("can be cleared, leaving new organizations unassigned", async () => {
    await sharedProvider("Only", { isDefault: true });
    expect((await setDefaultProviderAction(idle, form({ providerId: "" }))).status).toBe("ok");
    expect(await defaultProviderName()).toBeNull();

    const created = await organizationActions.createOrganizationAdminAction(idle, form({ name: "Bare" }));
    expect(created).toEqual({ status: "created", name: "Bare", providerName: null });
    const bare = (await listOrganizationsForOperator()).organizations.find((org) => org.name === "Bare");
    expect(bare?.provider).toBeNull();
  });

  it("is refused on a provider that serves one organization", async () => {
    const fixture = await seedFixture();
    const result = await setDefaultProviderAction(idle, form({ providerId: fixture.providerId }));
    expect(result.status).toBe("error");
    expect(await readDefaultProviderId()).toBeNull();
  });

  it("clears itself when the provider it names is deleted", async () => {
    const id = await sharedProvider("Hosted", { isDefault: true });
    await db.delete(providers).where(eq(providers.id, id));
    expect(await readDefaultProviderId()).toBeNull();
  });

  it("is refused when signed out", async () => {
    const id = await sharedProvider("Hosted");
    sessionState.userId = null;
    await expect(setDefaultProviderAction(idle, form({ providerId: id }))).rejects.toThrow();
  });
});

describe("convert", () => {
  let legacyId: string;

  beforeEach(async () => {
    sessionState.userId = await makeUser(true, operatorOrganizationId);
    const fixture = await seedFixture();
    legacyId = await legacyProvider(fixture.organizationId);
  });

  it("calls the library and reports the step it stopped at", async () => {
    convert.impl = async () => {
      throw new ConversionStoppedError("associate", "tenant", new Error("AccessDeniedException: not allowed"));
    };

    const result = await providerActions.convertProviderAction(idle, form({ id: legacyId }));

    expect(convert.calls).toEqual([{ id: legacyId, actor: expect.objectContaining({ type: "admin", id: sessionState.userId }) }]);
    expect(result).toEqual({ status: "stopped", stage: "associate", reached: "tenant", message: "AccessDeniedException: not allowed" });
  });

  it("reports a finished conversion", async () => {
    convert.impl = async () => ({ reached: "flip", converted: true, suppressionsCopied: 3, plan: {} });
    const result = await providerActions.convertProviderAction(idle, form({ id: legacyId }));
    expect(result).toEqual({ status: "converted", reached: "flip", suppressionsCopied: 3 });
  });

  it("refuses a shared provider without calling the library", async () => {
    const shared = await sharedProvider("Hosted");
    const result = await providerActions.convertProviderAction(idle, form({ id: shared }));
    expect(result).toMatchObject({ status: "error", message: "Hosted isn't a legacy provider." });
    expect(convert.calls).toHaveLength(0);
  });

  it("lists the row as needing conversion and plans it on the detail page", async () => {
    const [item] = (await listAdminProviders()).filter((provider) => provider.id === legacyId);
    expect(item).toMatchObject({ kind: "legacy", issues: ["needs_conversion"] });

    const detail = await readAdminProvider(legacyId);
    expect(detail?.conversion).toMatchObject({ blocked: null, parentExists: false });
    expect(detail?.conversion?.stages.map((entry) => entry.stage)).toEqual(["parent", "parent_setup", "tenant", "associate", "tag", "suppression", "flip"]);
  });
});

describe("provider list", () => {
  it("keeps a healthy provider quiet and marks a failing one", async () => {
    process.env.REDIS_URL = testRedisUrl();
    const healthy = await sharedProvider("Healthy");
    const failing = await sharedProvider("Failing");
    await clearRedisKeys("health:provider:");
    await recordProviderProbe(healthy, "ses", { ok: true, detail: null });
    await recordProviderProbe(failing, "ses", { ok: false, detail: "The security token included in the request is invalid." });

    const list = await listAdminProviders();
    expect(list.find((provider) => provider.id === healthy)?.issues).toEqual([]);
    expect(list.find((provider) => provider.id === failing)?.issues).toEqual(["credentials_failing"]);
    expect(list.some((provider) => provider.name === "system")).toBe(true);
    await clearRedisKeys("health:provider:");
  });

  it("never reads assignment rows as providers", async () => {
    sessionState.userId = await makeUser(true, operatorOrganizationId);
    const shared = await sharedProvider("Hosted");
    const result = await providerActions.assignOrganizationAction(idle, form({ id: shared, organizationId: await makeBareOrg() }));
    expect(result).toMatchObject({ status: "ok" });
    const tenant = await db.select().from(providers).where(eq(providers.sharedProviderId, shared));
    expect(tenant).toHaveLength(1);
    expect(await readAdminProvider(tenant[0]!.id)).toBeNull();
    expect((await readAdminProvider(shared))?.organizations.map((org) => org.assignmentId)).toEqual([tenant[0]!.id]);
    // A bare organization's first provider becomes its default.
    expect((await readAdminProvider(shared))?.organizations[0]?.isDefault).toBe(true);
  });
});

describe("assigning organizations from the provider screen", () => {
  beforeEach(async () => {
    sessionState.userId = await makeUser(true, operatorOrganizationId);
  });

  it("refuses to unassign an organization the provider doesn't serve", async () => {
    const shared = await sharedProvider("Hosted");
    const organizationId = await makeBareOrg();

    const result = await providerActions.unassignOrganizationAction(idle, form({ id: shared, organizationId }));
    expect(result).toMatchObject({ status: "error", field: "organization_id" });
    expect((result as { message: string }).message).toContain("isn't assigned provider Hosted");
  });
});

async function makeBareOrg(): Promise<string> {
  const id = newId("organization");
  await db.insert(organizations).values({ id, name: "Bare", slug: `bare-${id}` });
  return id;
}

describe("deleting a provider", () => {
  beforeEach(async () => {
    sessionState.userId = await makeUser(true, operatorOrganizationId);
  });

  it("sends the operator back to the list instead of re-rendering the row it deleted", async () => {
    const id = await sharedProvider("Going");

    try {
      await providerActions.deleteProviderAction(idle, form({ id, sharedProviderId: id }));
      expect.unreachable();
    } catch (error) {
      // A returned href let the detail route re-render first and answer 404 (#387).
      expect((error as { digest?: string }).digest).toMatch(/^NEXT_REDIRECT;[a-z]+;\/admin\/settings\/providers;/);
    }

    expect(await db.select().from(providers).where(eq(providers.id, id))).toHaveLength(0);
  });
});

describe("retired screens", () => {
  it.each([
    ["shared sending", SharedAccountsPage],
    ["provider accounts", ProviderAccountsPage],
  ])("redirects %s to providers", (_name, page) => {
    try {
      page();
      expect.unreachable();
    } catch (error) {
      expect((error as { digest?: string }).digest).toMatch(/^NEXT_REDIRECT;replace;\/admin\/settings\/providers;308;/);
    }
  });
});
