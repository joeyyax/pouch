import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, domains, organizations } from "@/lib/db/schema";
import { adminActor } from "@/lib/activity/record";
import { createApiKey } from "@/lib/api/key-lifecycle";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { listOrganizationsForOperator } from "@/lib/dashboard/admin-organizations";
import { setSetting } from "@/lib/settings/values";
import { POST as createAddressRoute } from "@/app/api/v1/addresses/route";
import { GET as readAdminOrganization, PATCH as patchAdminOrganization } from "@/app/api/v1/admin/organizations/[id]/route";
import { setAddressLimitsAction } from "@/app/(app)/admin/settings/organizations/actions";
import { apiRequest, form, resetDatabase, routeContext, seedFixture, seedUser, type Fixture } from "./fixtures";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const sessionState = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth/session", async () => (await import("./fixtures")).adminSessionModule(sessionState));

const ADMIN = adminActor("usr_admin", "Admin");
let fixture: Fixture;
let adminSecret: string;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture();
  await db.update(domains).set({ inboundEnabled: true }).where(eq(domains.id, fixture.domainId));
  const admin = await seedUser({ admin: true });
  sessionState.userId = admin.userId;
  adminSecret = (await createApiKey({ organizationId: null, name: "admin", mode: "live", domainIds: [], scope: "admin", createdBy: admin.userId })).secret;
});

async function createAddress(): Promise<{ status: number; detail?: unknown }> {
  const response = await createAddressRoute(apiRequest(fixture.secret, "/v1/addresses", "POST", { domain_id: fixture.domainId, expires_in: 3600 }));
  const body = (await response.json()) as { error?: { detail?: unknown } };
  return { status: response.status, detail: body.error?.detail };
}

async function patch(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await patchAdminOrganization(
    apiRequest(adminSecret, `/v1/admin/organizations/${fixture.organizationId}`, "PATCH", body),
    routeContext(fixture.organizationId),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("an organization's own address limits", () => {
  it("beat the install's default, raised or lowered, and null goes back to it", async () => {
    await setSetting("address_limit_default", 2, ADMIN);

    expect((await patch({ address_limit: 1 })).body).toMatchObject({ address_limit: 1, address_limit_override: 1 });
    expect((await createAddress()).status).toBe(201);
    expect(await createAddress()).toMatchObject({ status: 422, detail: { limit: 1 } });

    expect((await patch({ address_limit: 3 })).body).toMatchObject({ address_limit: 3 });
    expect((await createAddress()).status).toBe(201);
    expect((await createAddress()).status).toBe(201);
    expect(await createAddress()).toMatchObject({ status: 422, detail: { limit: 3 } });

    const reset = await patch({ address_limit: null });
    expect(reset.body).toMatchObject({ address_limit: 2, address_limit_override: null, address_daily_message_limit_override: null });
    const [row] = await db.select().from(organizations).where(eq(organizations.id, fixture.organizationId));
    expect(row!.addressLimit).toBeNull();
  });

  it("are recorded in the organization's activity, and an unchanged save records nothing", async () => {
    await patch({ address_daily_message_limit: 5 });
    await patch({ address_daily_message_limit: 5 });

    const rows = await db
      .select({ metadata: activity.metadata })
      .from(activity)
      .where(and(eq(activity.organizationId, fixture.organizationId), eq(activity.action, "settings.address_limits.changed")));
    expect(rows).toEqual([
      { metadata: { from: { addressLimit: null, addressDailyMessageLimit: null }, to: { addressLimit: null, addressDailyMessageLimit: 5 } } },
    ]);
  });

  it("are set from the admin organizations screen, blank following the default", async () => {
    const saved = await setAddressLimitsAction({ status: "idle" }, form({ id: fixture.organizationId, addressLimit: "7", addressDailyMessageLimit: "" }));
    expect(saved).toEqual({ status: "ok", message: "Address limits saved." });

    const { organizations: views } = await listOrganizationsForOperator();
    expect(views.find((view) => view.id === fixture.organizationId)?.addressLimits).toEqual({ active: 7, daily: 100, activeOverride: 7, dailyOverride: null });

    const refused = await setAddressLimitsAction({ status: "idle" }, form({ id: fixture.organizationId, addressLimit: "-1", addressDailyMessageLimit: "" }));
    expect(refused).toMatchObject({ status: "error", field: "address_limit" });

    const read = await readAdminOrganization(apiRequest(adminSecret, `/v1/admin/organizations/${fixture.organizationId}`), routeContext(fixture.organizationId));
    expect(await read.json()).toMatchObject({ address_limit: 7, address_limit_override: 7 });
  });
});
