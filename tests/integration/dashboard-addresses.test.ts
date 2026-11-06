import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { addressForwardTargets, addresses, apiKeys, domains, inboundMessages, organizations } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { createApiKey } from "@/lib/api/key-lifecycle";
import type { SerializedAddress } from "@/lib/addresses/serialize";
import { idle } from "@/lib/dashboard/action-state";
import { addDomainKey, apiRequest, resetDatabase, disableSystemMail, seedFixture, seedSystemOrganization, seedUser, type Fixture } from "./fixtures";

const sessionState = vi.hoisted(() => ({ organizationId: "" }));

vi.mock("@/lib/dashboard/session", async (importOriginal) =>
  (await import("./fixtures")).dashboardSessionModule(await importOriginal<typeof import("@/lib/dashboard/session")>(), sessionState),
);
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// No DMARC record anywhere, so a forward target's alignment check passes without the network.
vi.mock("node:dns/promises", () => {
  class Resolver {
    setServers() {}
    cancel() {}
    async resolveTxt(): Promise<string[][]> {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    }
  }
  return { Resolver, lookup: () => Promise.resolve([{ address: "203.0.113.9", family: 4 }]) };
});

const { default: AddressesPage } = await import("@/app/(app)/addresses/page");
const { default: AddressPage } = await import("@/app/(app)/addresses/[id]/page");
const { createAddressAction, extendAddressAction, revokeAddressAction } = await import("@/app/(app)/addresses/actions");
const { POST: createRoute } = await import("@/app/api/v1/addresses/route");

const HOUR = 60 * 60 * 1000;

let fixture: Fixture;

async function address(values: Partial<typeof addresses.$inferInsert> = {}, organizationId = fixture.organizationId, domainId = fixture.domainId): Promise<string> {
  const id = newId("address");
  await db.insert(addresses).values({
    id,
    organizationId,
    domainId,
    apiKeyId: organizationId === fixture.organizationId ? fixture.key.id : null,
    localPart: `a-${id.slice(-8).toLowerCase()}`,
    expiresAt: new Date(Date.now() + HOUR),
    ...values,
  });
  return id;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  sessionState.organizationId = fixture.organizationId;
});

describe("addresses page", () => {
  it("lists the organization's addresses with its limits and counts by status, and nobody else's", async () => {
    await address();
    await address({ expiresAt: new Date(Date.now() - HOUR) });
    await address({ status: "revoked", revokedAt: new Date() });
    await db.update(organizations).set({ addressLimit: 3, addressDailyMessageLimit: 7 }).where(eq(organizations.id, fixture.organizationId));
    const other = await seedFixture();
    await address({}, other.organizationId, other.domainId);

    const element = await AddressesPage({ searchParams: Promise.resolve({}) });
    const props = element.props as { addresses: SerializedAddress[]; counts: Record<string, number>; limits: { active: number; daily: number } };
    expect(props.addresses).toHaveLength(3);
    expect(props.counts).toEqual({ active: 1, expired: 1, revoked: 1 });
    expect(props.limits).toEqual({ active: 3, daily: 7 });

    const expired = await AddressesPage({ searchParams: Promise.resolve({ status: "expired" }) });
    expect((expired.props as { addresses: SerializedAddress[] }).addresses.map((row) => row.status)).toEqual(["expired"]);
  });
});

describe("address page", () => {
  it("reads the address, its mail without bodies, its forward targets and the key that made it", async () => {
    const id = await address({ receivedCount: 1 });
    await db.insert(addressForwardTargets).values({ id: newId("forwardTarget"), organizationId: fixture.organizationId, addressId: id, email: "ops@example.com" });
    await db.insert(inboundMessages).values({
      id: newId("inbound"),
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      providerMessageId: "p-1",
      fromAddress: "ada@example.net",
      to: ["x@inbound.example.com"],
      subject: "Your code",
      headers: {},
      attachments: [],
      addressIds: [id],
      threadId: newId("thread"),
      receivedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * HOUR),
    });

    const element = await AddressPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
    const props = element.props as { address: SerializedAddress; messages: Record<string, unknown>[]; targets: { email: string; status: string }[]; keyName: string | null };
    expect(props.address.id).toBe(id);
    expect(props.messages).toHaveLength(1);
    expect(props.messages[0]).toMatchObject({ from: "ada@example.net", subject: "Your code" });
    expect(props.messages[0]).not.toHaveProperty("text");
    expect(props.targets).toEqual([expect.objectContaining({ email: "ops@example.com", status: "pending" })]);
    expect(props.keyName).toBe(fixture.key.name);
  });

  it("is a 404 for another organization's address", async () => {
    const other = await seedFixture();
    const id = await address({}, other.organizationId, other.domainId);
    await expect(AddressPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });
});

describe("extend and revoke", () => {
  it("reopens an expired address from now, then revokes it for good", async () => {
    const id = await address({ status: "expired", expiresAt: new Date(Date.now() - HOUR) });

    const extended = await extendAddressAction(idle, form({ id, expires_in: String(7 * 24 * 3600) }));
    expect(extended.status).toBe("ok");
    const [reopened] = await db.select().from(addresses).where(eq(addresses.id, id));
    expect(reopened!.status).toBe("active");
    expect(reopened!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * HOUR);

    expect((await revokeAddressAction(idle, form({ id }))).status).toBe("ok");
    const [revoked] = await db.select().from(addresses).where(eq(addresses.id, id));
    expect(revoked!.status).toBe("revoked");

    const again = await extendAddressAction(idle, form({ id, expires_in: "3600" }));
    expect(again).toMatchObject({ status: "error", message: "A revoked address can't be edited." });
  });

  it("refuses to reopen past the organization's active limit", async () => {
    await db.update(organizations).set({ addressLimit: 1 }).where(eq(organizations.id, fixture.organizationId));
    await address();
    const id = await address({ status: "expired", expiresAt: new Date(Date.now() - HOUR) });
    const refused = await extendAddressAction(idle, form({ id, expires_in: "3600" }));
    expect(refused.status).toBe("error");
    expect(refused).toMatchObject({ message: expect.stringContaining("its limit") });
  });

  it("can't reach another organization's address", async () => {
    const other = await seedFixture();
    const id = await address({}, other.organizationId, other.domainId);
    expect(await revokeAddressAction(idle, form({ id }))).toMatchObject({ status: "error", message: `No address with id ${id}.` });
    const [row] = await db.select().from(addresses).where(eq(addresses.id, id));
    expect(row!.status).toBe("active");
  });
});

describe("create", () => {
  /** The path a server action's redirect names, or the state it returned instead. */
  async function submit(fields: Record<string, string>): Promise<{ redirect: string } | Awaited<ReturnType<typeof createAddressAction>>> {
    try {
      return await createAddressAction(idle, form({ domain_id: fixture.domainId, key_id: fixture.key.id, expires_in: "3600", ...fields }));
    } catch (error) {
      const digest = (error as { digest?: string }).digest ?? "";
      if (!digest.startsWith("NEXT_REDIRECT;")) throw error;
      return { redirect: digest.split(";")[2]! };
    }
  }

  async function createdRow(fields: Record<string, string>) {
    const result = await submit(fields);
    expect(result).toHaveProperty("redirect");
    const url = new URL((result as { redirect: string }).redirect, "http://localhost");
    expect(url.searchParams.get("forward_error")).toBeNull();
    const id = url.pathname.replace("/addresses/", "");
    const [row] = await db.select().from(addresses).where(eq(addresses.id, id));
    return row!;
  }

  beforeEach(async () => {
    await db.update(domains).set({ inboundEnabled: true }).where(eq(domains.id, fixture.domainId));
  });

  it("creates as the chosen key and lands on the new address", async () => {
    const row = await createdRow({ local_part: "Signup", label: "Signup flow", message_cap: "5", expires_in: String(24 * 3600) });
    expect(row).toMatchObject({ organizationId: fixture.organizationId, apiKeyId: fixture.key.id, domainId: fixture.domainId, localPart: "signup", label: "Signup flow", messageCap: 5 });
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);

    const random = await createdRow({});
    expect(random.localPart).toMatch(/^[0-9a-z]{16}$/);
    expect(random.apiKeyId).toBe(fixture.key.id);
  });

  it("refuses what the API refuses, with the API's words, on the field", async () => {
    await createdRow({ local_part: "taken" });
    expect(await submit({ local_part: "taken" })).toMatchObject({ status: "error", field: "local_part", message: "taken is already taken on example.com." });
    expect(await submit({ local_part: "postmaster" })).toMatchObject({ status: "error", field: "local_part", message: "This local part is reserved for the domain." });
    expect(await submit({ message_cap: "0" })).toMatchObject({ status: "error", field: "message_cap" });
    expect(await submit({ forward_to: "nope" })).toMatchObject({ status: "error", field: "forward_to", message: "nope isn't a valid address." });

    await db.update(domains).set({ inboundEnabled: false }).where(eq(domains.id, fixture.domainId));
    expect(await submit({})).toMatchObject({ status: "error", field: "domain_id", message: expect.stringContaining("Inbound isn't enabled on example.com") });
  });

  it("holds a member to the keys the organization can create with", async () => {
    const test = await createApiKey({ organizationId: fixture.organizationId, name: "ci", mode: "test", domainIds: [] });
    expect(await submit({ key_id: test.key.id })).toMatchObject({ status: "error", message: "A test-mode key can't manage addresses." });

    const revoked = await createApiKey({ organizationId: fixture.organizationId, name: "old", mode: "live", domainIds: [] });
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, revoked.key.id));
    expect(await submit({ key_id: revoked.key.id })).toMatchObject({ status: "error", field: "key_id", message: "old is revoked. Choose a live key." });

    const operator = await seedUser({ admin: true });
    const admin = await createApiKey({ organizationId: null, name: "admin", mode: "live", domainIds: [], scope: "admin", createdBy: operator.userId });
    expect(await submit({ key_id: admin.key.id })).toMatchObject({ status: "error", field: "key_id", message: `No key with id ${admin.key.id}.` });

    // A key limited to one domain can't create on another, as on the API.
    const second = await addDomainKey(fixture);
    await db.update(domains).set({ inboundEnabled: true }).where(eq(domains.id, second.domainId));
    expect(await submit({ domain_id: second.domainId })).toMatchObject({ status: "error", field: "domain_id", message: "This key can't reach second.example.com." });
    expect((await createdRow({ key_id: second.key.id, domain_id: second.domainId })).apiKeyId).toBe(second.key.id);

    expect(await db.select().from(addresses).where(eq(addresses.organizationId, fixture.organizationId))).toHaveLength(1);
  });

  it("applies the organization's address limit exactly as the API does", async () => {
    await db.update(organizations).set({ addressLimit: 1 }).where(eq(organizations.id, fixture.organizationId));
    await address();

    const refused = await submit({});
    const response = await createRoute(apiRequest(fixture.secret, "/v1/addresses", "POST", { domain_id: fixture.domainId, expires_in: 3600 }));
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("address_limit_reached");
    expect(refused).toEqual({ status: "error", message: body.error.message });
  });

  it("adds each mailbox the way the forward target route does, as the chosen key", async () => {
    await seedSystemOrganization();
    const row = await createdRow({ forward_to: "ops@example.net\nOps@example.net, dev@example.net" });
    const targets = await db.select().from(addressForwardTargets).where(eq(addressForwardTargets.addressId, row.id));
    expect(targets.map((target) => [target.email, target.status]).sort()).toEqual([
      ["dev@example.net", "pending"],
      ["ops@example.net", "pending"],
    ]);
  });

  it("keeps the address and says why when a mailbox can't be added", async () => {
    await disableSystemMail();
    const result = await submit({ forward_to: "ops@example.net" });
    const url = new URL((result as { redirect: string }).redirect, "http://localhost");
    expect(url.pathname).toMatch(/^\/addresses\/adr_/);
    expect(url.searchParams.get("forward_error")).toBeTruthy();
    expect(await db.select().from(addressForwardTargets)).toHaveLength(0);
    expect(await db.select().from(addresses)).toHaveLength(1);
  });

  it("refuses another organization's key and domain", async () => {
    const other = await seedFixture();
    await db.update(domains).set({ inboundEnabled: true }).where(eq(domains.id, other.domainId));

    expect(await submit({ key_id: other.key.id, domain_id: other.domainId })).toMatchObject({ status: "error", field: "key_id", message: `No key with id ${other.key.id}.` });
    const unscoped = await createApiKey({ organizationId: fixture.organizationId, name: "all", mode: "live", domainIds: [] });
    expect(await submit({ key_id: unscoped.key.id, domain_id: other.domainId })).toMatchObject({ status: "error", field: "domain_id", message: `No domain with id ${other.domainId}.` });
    expect(await db.select().from(addresses)).toHaveLength(0);
  });
});
