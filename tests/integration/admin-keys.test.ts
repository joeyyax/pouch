import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, users } from "@/lib/db/schema";
import { authenticateSecret } from "@/lib/api/keys";
import { createApiKey, revokeApiKey } from "@/lib/api/key-lifecycle";
import { withAdminKey, withApiKey } from "@/lib/api/with-key";
import { deleteUserAccount, setAdmin } from "@/lib/auth/admin";
import { ROLES, type OrgRole } from "@/lib/auth/permissions";
import { listAdminKeys, listKeys, readKey } from "@/lib/dashboard/keys";
import { createAdminKey } from "@/lib/keys/admin";
import { updateKey } from "@/lib/keys";
import { createAdminKeyAction, revokeAdminKeyAction } from "@/app/(app)/admin/settings/api-keys/actions";
import { form, resetDatabase, seedFixture, seedSystemOrganization, seedUser, systemMailMessages, type Fixture } from "./fixtures";

const sessionState = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/auth/session", async () => (await import("./fixtures")).adminSessionModule(sessionState));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let system: { organizationId: string; domainId: string };
let fixture: Fixture;
let adminId: string;
let otherAdminId: string;
let ownerId: string;

async function makeUser(organizationId: string, admin: boolean, role?: OrgRole): Promise<string> {
  return (await seedUser({ organizationId, admin, role })).userId;
}

function adminKey(createdBy: string, overrides: Partial<Parameters<typeof createApiKey>[0]> = {}) {
  return createApiKey({
    organizationId: null,
    name: "mcp",
    mode: "live",
    domainIds: [],
    scope: "admin",
    createdBy,
    ...overrides,
  });
}

async function row(id: string) {
  const [found] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  return found!;
}

const ok = async () => Response.json({ ok: true });

function call(handler: ReturnType<typeof withApiKey>, secret: string): Promise<Response> {
  return handler(new Request("https://mail.example.com/v1/admin/organizations", { headers: { authorization: `Bearer ${secret}` } }));
}

const idle = { status: "idle" as const };

beforeEach(async () => {
  await resetDatabase();
  system = await seedSystemOrganization();
  fixture = await seedFixture();
  adminId = await makeUser(fixture.organizationId, true);
  otherAdminId = await makeUser(fixture.organizationId, true);
  ownerId = await makeUser(system.organizationId, false, ROLES.OWNER);
  sessionState.userId = null;
});

describe("minting an admin key", () => {
  it("refuses a creator who isn't an admin", async () => {
    await expect(adminKey(ownerId)).rejects.toMatchObject({ code: "admin_scope_not_allowed" });
    await expect(adminKey("")).rejects.toMatchObject({ code: "admin_scope_not_allowed" });
    expect(await db.select().from(apiKeys).where(eq(apiKeys.scope, "admin"))).toHaveLength(0);
  });

  it("refuses an owner who isn't an admin, from the dashboard action", async () => {
    sessionState.userId = ownerId;
    await expect(createAdminKeyAction(idle, form({ name: "mcp" }))).rejects.toThrow(/Forbidden/);
    expect(await db.select().from(apiKeys).where(eq(apiKeys.scope, "admin"))).toHaveLength(0);
  });

  it("refuses domain limits, in code and in the database", async () => {
    await expect(adminKey(adminId, { domainIds: [system.domainId] })).rejects.toMatchObject({
      code: "admin_scope_not_allowed",
      message: "An admin key can't be limited to domains.",
    });

    const { key } = await adminKey(adminId);
    await expect(db.update(apiKeys).set({ domainIds: [system.domainId] }).where(eq(apiKeys.id, key.id))).rejects.toThrow();
    expect((await row(key.id)).domainIds).toEqual([]);
  });

  it("refuses an organization, and test mode", async () => {
    await expect(adminKey(adminId, { organizationId: fixture.organizationId })).rejects.toMatchObject({
      code: "admin_scope_not_allowed",
    });
    await expect(adminKey(adminId, { mode: "test" })).rejects.toMatchObject({ code: "admin_scope_not_allowed" });
  });

  it("mints one for an admin from the dashboard action and lists it with its creator", async () => {
    sessionState.userId = adminId;
    const outcome = await createAdminKeyAction(idle, form({ name: "mcp" }));
    expect(outcome.status).toBe("created");

    const [listed] = await listAdminKeys();
    expect(listed).toMatchObject({ name: "mcp", refused: false, revokedAt: null, lastUsedAt: null });
    expect(listed?.creatorName).toBeTruthy();
    const stored = await row(listed!.id);
    expect(stored).toMatchObject({ scope: "admin", createdBy: adminId, organizationId: null });
  });
});

describe("using an admin key", () => {
  it("reaches admin routes and is refused on the ordinary ones", async () => {
    const { key, secret } = await adminKey(adminId);

    expect((await call(withAdminKey(ok), secret)).status).toBe(200);

    let reached = false;
    const response = await call(
      withApiKey(async () => {
        reached = true;
        return ok();
      }),
      secret,
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("organization_key_required");
    expect(reached).toBe(false);
    expect(key.domainIds).toEqual([]);
  });
});

describe("revocation when the creator stops being an admin", () => {
  it("revokes the creator's admin keys when they're demoted, and no one else's", async () => {
    const mine = await adminKey(adminId);
    const theirs = await adminKey(otherAdminId, { name: "other" });

    await setAdmin(adminId, false);

    expect(await row(mine.key.id)).toMatchObject({ revokedReason: "creator_demoted" });
    expect((await row(mine.key.id)).revokedAt).not.toBeNull();
    await expect(authenticateSecret(mine.secret)).rejects.toMatchObject({ code: "invalid_key" });
    expect((await row(theirs.key.id)).revokedAt).toBeNull();
    await expect(authenticateSecret(theirs.secret)).resolves.toMatchObject({ id: theirs.key.id });
  });

  it("revokes the creator's admin keys when their provider is deleted", async () => {
    const { key, secret } = await adminKey(adminId);

    await deleteUserAccount(adminId);

    expect(await row(key.id)).toMatchObject({ revokedReason: "creator_deleted", createdBy: null });
    await expect(authenticateSecret(secret)).rejects.toMatchObject({ code: "invalid_key" });
  });

  it("refuses a key whose creator lost admin outside setAdmin", async () => {
    const { key, secret } = await adminKey(adminId);
    await db.update(users).set({ admin: false }).where(eq(users.id, adminId));

    await expect(authenticateSecret(secret)).rejects.toMatchObject({
      code: "invalid_key",
      message: "This admin key's creator is no longer an admin.",
    });
    expect((await call(withApiKey(ok), secret)).status).toBe(401);
    expect((await row(key.id)).revokedAt).toBeNull();
    expect((await listAdminKeys())[0]).toMatchObject({ refused: true });
  });

  it("refuses a key whose creator was removed without deleteUserAccount", async () => {
    const { key, secret } = await adminKey(adminId);
    await db.delete(users).where(eq(users.id, adminId));

    expect((await row(key.id)).createdBy).toBeNull();
    await expect(authenticateSecret(secret)).rejects.toMatchObject({ code: "invalid_key" });
  });

  it("leaves a demoted admin's organization keys working", async () => {
    const orgKey = await createApiKey({
      organizationId: fixture.organizationId,
      name: "site",
      mode: "live",
      domainIds: [],
      createdBy: adminId,
    });

    await setAdmin(adminId, false);

    expect((await row(orgKey.key.id)).revokedAt).toBeNull();
    await expect(authenticateSecret(orgKey.secret)).resolves.toMatchObject({ id: orgKey.key.id });
    await expect(authenticateSecret(fixture.secret)).resolves.toMatchObject({ id: fixture.key.id });
  });

  it("still refuses to demote the last admin, and revokes nothing", async () => {
    await setAdmin(otherAdminId, false);
    const { key } = await adminKey(adminId);

    await expect(setAdmin(adminId, false)).rejects.toThrow("This is the only admin.");
    expect((await row(key.id)).revokedAt).toBeNull();
  });
});

describe("admin keys stay off organization screens", () => {
  it("never lists, reads, edits or revokes an admin key through the organization's own paths", async () => {
    const { key } = await adminKey(adminId);

    expect((await listKeys(system.organizationId, "UTC")).map((listed) => listed.id)).not.toContain(key.id);
    expect(await readKey(system.organizationId, key.id, "UTC")).toBeNull();
    await expect(
      updateKey(
        { organizationId: system.organizationId, domainIds: [], actor: { type: "user", id: null, label: "Admin" } },
        key.id,
        { name: "renamed", domain_ids: [], rate_limit: 10 },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await revokeApiKey(system.organizationId, key.id)).toBeNull();
    expect((await row(key.id)).revokedAt).toBeNull();
  });

  it("never sends the system organization's own mail with an admin key", async () => {
    const { key } = await adminKey(adminId);
    const sent = await systemMailMessages();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map((message) => message.apiKeyId)).not.toContain(key.id);
  });

  it("revokes from the admin screen only for an admin", async () => {
    const { key } = await createAdminKey({ id: adminId, name: "Admin" }, { name: "mcp" });

    sessionState.userId = ownerId;
    await expect(revokeAdminKeyAction(idle, form({ id: key.id }))).rejects.toThrow(/Forbidden/);
    expect((await row(key.id)).revokedAt).toBeNull();

    sessionState.userId = adminId;
    expect(await revokeAdminKeyAction(idle, form({ id: key.id }))).toMatchObject({ status: "ok" });
    expect(await row(key.id)).toMatchObject({ revokedReason: null });
    expect((await row(key.id)).revokedAt).not.toBeNull();
  });

  it("doesn't revoke an organization key from the admin screen", async () => {
    sessionState.userId = adminId;
    const outcome = await revokeAdminKeyAction(idle, form({ id: fixture.key.id }));
    expect(outcome.status).toBe("error");
    expect((await row(fixture.key.id)).revokedAt).toBeNull();
  });
});
