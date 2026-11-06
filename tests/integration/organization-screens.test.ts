/** Organization screens under admin-owned providers (#355, increment 7). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, memberships, organizations, providers, users } from "@/lib/db/schema";
import { ROLES } from "@/lib/auth/permissions";
import { encryptCredentials } from "@/lib/providers";
import { newId } from "@/lib/ids";
import { addDomainAction } from "@/app/(app)/domains/actions";
import DomainsPage from "@/app/(app)/domains/page";
import { AddDomainForm } from "@/app/(app)/domains/domains-screen";
import { listProviderOptions } from "@/lib/dashboard/domains";
import OverviewPage from "@/app/(app)/page";
import SendingPage from "@/app/(app)/settings/sending/page";
import { addProvider, form, resetDatabase, seedFixture, type Fixture } from "./fixtures";

const sessionState = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/auth/session", async () => (await import("./fixtures")).adminSessionModule(sessionState));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}));

let fixture: Fixture;

async function signIn(options: { admin?: boolean } = {}): Promise<void> {
  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    organizationId: fixture.organizationId,
    name: "Ada",
    email: `${userId}@example.com`,
    admin: options.admin ?? false,
  });
  await db.insert(memberships).values({ id: newId("membership"), userId, organizationId: fixture.organizationId, role: ROLES.OWNER });
  sessionState.userId = userId;
}

async function assign(providerId: string | null): Promise<void> {
  await db.update(organizations).set({ providerId: providerId }).where(eq(organizations.id, fixture.organizationId));
}

/** Markup with entities decoded, so assertions read like the copy. */
function html(element: ReactElement): string {
  return renderToStaticMarkup(element).replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
}

async function settings(): Promise<string> {
  return html(await SendingPage());
}

/** The add-domain form lives in a modal, which portals and so renders nothing on the server. */
async function addDomainScreen(): Promise<string> {
  return html(createElement(AddDomainForm, { providers: await listProviderOptions(fixture.organizationId), onCancel: () => {} }));
}

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ concurrency: 8 });
  sessionState.userId = null;
  await signIn();
});

describe("Settings → Sending", () => {
  it("shows the assigned provider's name, adapter and status, and never its concurrency or credentials", async () => {
    await assign(fixture.providerId);
    const page = await settings();

    expect(page).toContain("Sending");
    expect(page).toContain("primary");
    expect(page).toMatch(/>ready</);
    expect(page).not.toMatch(/sends at once/i);
    expect(page).not.toMatch(/concurrency/i);
    expect(page).not.toMatch(/credential/i);
    expect(page).not.toContain("test-token");
    expect(page).not.toContain("Manage");
  });

  it("says why when the provider asks for a pause", async () => {
    await assign(fixture.providerId);
    await db
      .update(providers)
      .set({ backoffUntil: new Date(Date.now() + 10 * 60_000) })
      .where(eq(providers.id, fixture.providerId));

    const page = await settings();
    expect(page).toMatch(/>paused</);
    expect(page).toContain("The provider asked for a pause.");
  });

  it("says queued mail waits when the provider pauses a tenant, and links an admin to the shared provider", async () => {
    const sharedId = newId("provider");
    await db.insert(providers).values({
      id: sharedId,
      adapter: "ses",
      name: "hosted",
      credentials: encryptCredentials({ accessKeyId: "AKIA", secretAccessKey: "s", region: "us-west-2" }),
      shared: true,
    });
    await db
      .update(providers)
      .set({ adapter: "ses", sharedProviderId: sharedId, settings: { tenantName: "t", tenantArn: "arn:tenant" } })
      .where(eq(providers.id, fixture.providerId));
    await assign(fixture.providerId);
    await db
      .update(organizations)
      .set({ suspendedAt: new Date(), suspendSource: "provider", suspendReason: "Paused by SES." })
      .where(eq(organizations.id, fixture.organizationId));

    const member = await settings();
    expect(member).toMatch(/>paused</);
    expect(member).toContain("The provider paused sending. Queued mail sends when it lifts.");
    expect(member).not.toContain(sharedId);

    await signIn({ admin: true });
    expect(await settings()).toContain(`href="/admin/settings/providers/${sharedId}"`);
  });

  it("says the organization can't send when nothing is assigned", async () => {
    await assign(null);
    expect(await settings()).toContain("This organization can't send yet");
  });
});

describe("Overview", () => {
  it("shows the can't-send banner only while no provider is assigned", async () => {
    await assign(null);
    const unassigned = html(await OverviewPage({ searchParams: Promise.resolve({}) }));
    expect(unassigned).toContain("This organization can't send yet");
    expect(unassigned).toContain("An admin needs to assign it a provider.");

    await assign(fixture.providerId);
    const assigned = html(await OverviewPage({ searchParams: Promise.resolve({}) }));
    expect(assigned).not.toContain("can't send yet");
  });
});

describe("Domains → Add domain", () => {
  it("hides the picker with one provider and names the provider it binds to", async () => {
    await assign(fixture.providerId);
    const page = await addDomainScreen();

    expect(page).not.toContain('name="providerId"');
    expect(page).not.toContain("<select");
    expect(page).toMatch(/Sends through <span[^>]*>primary<\/span>/);
  });

  it("binds a domain added without a picker to the assigned provider", async () => {
    await assign(fixture.providerId);
    const result = await addDomainAction({ status: "idle" }, form({ name: "new.example.com" })).catch((error: Error) => error);

    expect(String(result)).toMatch(/^Error: REDIRECT:\/domains\/dom_/);
    const [row] = await db.select().from(domains).where(eq(domains.name, "new.example.com"));
    expect(row?.providerId).toBe(fixture.providerId);
  });

  it("answers an invalid name under the field, without calling the provider", async () => {
    await assign(fixture.providerId);
    const result = await addDomainAction({ status: "idle" }, form({ name: "not a domain" }));

    expect(result).toEqual({ status: "error", message: "Provide a domain name, such as example.com.", field: "name" });
  });

  it("offers the picker, preselecting the assigned provider, when there are two", async () => {
    const second = await addProvider(fixture, { providerAdapter: "mock", name: "another" });
    await assign(second.providerId);
    const page = await addDomainScreen();

    expect(page).toContain('name="providerId"');
    expect(page).toContain(`<option value="${second.providerId}" selected="">`);
  });

  it("blocks adding a domain with no provider, on the screen and in the action", async () => {
    await assign(null);
    const list = html(await DomainsPage({ searchParams: Promise.resolve({}) }));
    expect(list).toContain("This organization can't send yet");

    const page = await addDomainScreen();
    expect(page).toContain("This organization can't send yet");
    expect(page).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);

    const result = await addDomainAction({ status: "idle" }, form({ name: "new.example.com" }));
    expect(result).toEqual({
      status: "error",
      message: "This organization can't add a domain yet. An admin needs to assign it a provider.",
      field: "provider_id",
    });
  });
});
