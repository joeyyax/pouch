import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { lists } from "@/lib/db/schema";
import { adminActor } from "@/lib/activity/record";
import { setSetting } from "@/lib/settings/values";
import { form, resetDatabase, seedFixture, type Fixture } from "./fixtures";

const sessionState = vi.hoisted(() => ({ organizationId: "" }));

vi.mock("@/lib/dashboard/session", async (importOriginal) =>
  (await import("./fixtures")).dashboardSessionModule(await importOriginal<typeof import("@/lib/dashboard/session")>(), sessionState),
);
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const { createListAction } = await import("@/app/(app)/lists/actions");

const idle = { status: "idle" } as const;

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
  sessionState.organizationId = fixture.organizationId;
});

describe("a feature's dashboard actions", () => {
  it("refuse while the feature is off, and work while it's on", async () => {
    const fields = form({ domain_id: fixture.domainId, name: "News" });

    await setSetting("lists", false, adminActor("usr_admin", "Admin"));
    expect(await createListAction(idle, fields)).toMatchObject({ status: "error", message: expect.stringContaining('"lists" is turned off') });
    expect(await db.select().from(lists).where(eq(lists.organizationId, fixture.organizationId))).toHaveLength(0);

    await setSetting("lists", true, adminActor("usr_admin", "Admin"));
    await expect(createListAction(idle, fields)).rejects.toThrow(/^REDIRECT:\/lists\/lst_/);
  });
});
