/**
 * A manual add from the dashboard records the same activity the API's add does. It used to
 * record nothing, so an address added by hand appeared in the list with nothing saying who
 * added it (#419).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, listMemberships } from "@/lib/db/schema";
import { createList } from "@/lib/lists";
import { idle } from "@/lib/dashboard/action-state";
import { form, resetDatabase, seedFixture, type Fixture } from "./fixtures";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const sessionState = vi.hoisted(() => ({ organizationId: "" }));

vi.mock("@/lib/dashboard/session", async (importOriginal) =>
  (await import("./fixtures")).dashboardSessionModule(await importOriginal<typeof import("@/lib/dashboard/session")>(), sessionState),
);

const { addMemberAction } = await import("@/app/(app)/lists/actions");

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  sessionState.organizationId = fixture.organizationId;
});

describe("adding a list member from the dashboard", () => {
  it("records the add, naming the list and the person who did it", async () => {
    const list = await createList(
      { organizationId: fixture.organizationId, domainIds: [], actor: { type: "user", id: "usr_test", label: "Ada" } },
      { domain_id: fixture.domainId, name: "Newsletter", double_opt_in: false },
    );

    const result = await addMemberAction(idle, form({ list_id: list.id, address: "reader@example.com" }));
    expect(result).toMatchObject({ status: "ok" });

    const [row] = await db
      .select()
      .from(activity)
      .where(and(eq(activity.organizationId, fixture.organizationId), eq(activity.action, "list.member.added")));
    expect(row).toBeTruthy();
    expect(row?.subjectLabel).toBe("Newsletter");
    expect(row?.actorLabel).toBe("Ada");
    // The address lives on the membership, never in the log.
    expect(JSON.stringify(row)).not.toContain("reader@example.com");
  });

  // The list decides, not the form. A checkbox on the add form let an operator add an address to
  // a double opt-in list as already confirmed, which the API refuses for the same list (#453).
  it("takes the opt-in mode from the list, not the form", async () => {
    const list = await createList(
      { organizationId: fixture.organizationId, domainIds: [], actor: { type: "user", id: "usr_test", label: "Ada" } },
      { domain_id: fixture.domainId, name: "Newsletter", double_opt_in: true },
    );

    const result = await addMemberAction(idle, form({ list_id: list.id, address: "reader@example.com", double_opt_in: "false" }));
    expect(result).toMatchObject({ status: "ok" });

    const [member] = await db
      .select()
      .from(listMemberships)
      .where(and(eq(listMemberships.listId, list.id), eq(listMemberships.address, "reader@example.com")));
    expect(member?.doubleOptIn).toBe(true);
    expect(member?.status).toBe("pending");
  });
});
