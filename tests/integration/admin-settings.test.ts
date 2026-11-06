/**
 * The load-bearing test for #163's admin surface: an org admin who is not an admin must
 * not be able to reach any `/admin/settings` action, server-side, regardless of what the nav
 * shows. An admin must be able to. Mirrors `role-enforcement.test.ts`'s approach — calling
 * the server actions directly, the same way a crafted request would, rather than only checking
 * the rendered page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { ROLES, type OrgRole } from "@/lib/auth/permissions";
import { promoteAdminAction, demoteAdminAction } from "@/app/(app)/admin/settings/admins/actions";
import { form, resetDatabase, seedUser } from "./fixtures";

const sessionState = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/auth/session", async () => (await import("./fixtures")).adminSessionModule(sessionState));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

async function makeUser(options: { organizationId: string; role?: OrgRole; admin?: boolean }): Promise<string> {
  return (await seedUser(options)).userId;
}

let organizationId: string;
let orgAdminId: string;
let operatorId: string;

beforeEach(async () => {
  await resetDatabase();
  organizationId = newId("organization");
  await db.insert(organizations).values({ id: organizationId, name: "Test", slug: `test-${organizationId}` });
  orgAdminId = await makeUser({ organizationId, role: ROLES.OWNER, admin: false });
  operatorId = await makeUser({ organizationId, role: ROLES.MEMBER, admin: true });
  sessionState.userId = null;
});

const idle = { status: "idle" as const };

describe("promoteAdminAction", () => {
  it("refuses an org admin who is not an admin, server-side", async () => {
    sessionState.userId = orgAdminId;
    const target = await makeUser({ organizationId, admin: false });
    const [row] = await db.select().from(users).where(eq(users.id, target)).limit(1);

    await expect(promoteAdminAction(idle, form({ email: row!.email }))).rejects.toThrow(/Forbidden/);

    const [after] = await db.select().from(users).where(eq(users.id, target)).limit(1);
    expect(after?.admin).toBe(false);
  });

  it("allows an admin to promote another provider by email", async () => {
    sessionState.userId = operatorId;
    const target = await makeUser({ organizationId, admin: false });
    const [row] = await db.select().from(users).where(eq(users.id, target)).limit(1);

    const outcome = await promoteAdminAction(idle, form({ email: row!.email }));

    expect(outcome.status).toBe("ok");
    const [after] = await db.select().from(users).where(eq(users.id, target)).limit(1);
    expect(after?.admin).toBe(true);
  });
});

describe("demoteAdminAction", () => {
  it("refuses an org admin who is not an admin, server-side", async () => {
    sessionState.userId = orgAdminId;

    await expect(demoteAdminAction(idle, form({ id: operatorId }))).rejects.toThrow(/Forbidden/);

    const [after] = await db.select().from(users).where(eq(users.id, operatorId)).limit(1);
    expect(after?.admin).toBe(true);
  });

  it("allows an admin to remove another admin's access", async () => {
    const secondOperatorId = await makeUser({ organizationId, admin: true });
    sessionState.userId = operatorId;

    const outcome = await demoteAdminAction(idle, form({ id: secondOperatorId }));

    expect(outcome.status).toBe("ok");
    const [after] = await db.select().from(users).where(eq(users.id, secondOperatorId)).limit(1);
    expect(after?.admin).toBe(false);
  });

  it("refuses an unauthenticated caller, server-side", async () => {
    sessionState.userId = null;
    await expect(demoteAdminAction(idle, form({ id: operatorId }))).rejects.toThrow();
  });
});
