import { beforeEach, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { listMemberships } from "@/lib/db/schema";
import { userActor } from "@/lib/activity/record";
import { createList } from "@/lib/lists";
import { newId } from "@/lib/ids";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

const sessionState = vi.hoisted(() => ({ organizationId: "" }));

vi.mock("@/lib/dashboard/session", async (importOriginal) =>
  (await import("./fixtures")).dashboardSessionModule(await importOriginal<typeof import("@/lib/dashboard/session")>(), sessionState),
);

const { default: ListDetailPage } = await import("@/app/(app)/lists/[id]/page");

interface DetailProps {
  members: { id: string; status: string }[];
  counts: Record<string, number>;
  total: number;
  status: string | null;
  nextCursor: string | null;
}

async function render(listId: string, cursor?: string, status?: string): Promise<DetailProps> {
  const element = await ListDetailPage({
    params: Promise.resolve({ id: listId }),
    searchParams: Promise.resolve({ ...(cursor ? { cursor } : {}), ...(status ? { status } : {}) }),
  });
  return element.props as DetailProps;
}

const MEMBERS = 230;

let fixture: Fixture;
let listId: string;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  sessionState.organizationId = fixture.organizationId;
  const list = await createList(
    { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u1", "Test") },
    { domain_id: fixture.domainId, name: "Newsletter", double_opt_in: false },
  );
  listId = list.id;
  // One statement, so every row shares a timestamp and only the id orders them.
  await db.insert(listMemberships).values(
    Array.from({ length: MEMBERS }, (_, i) => ({
      id: newId("listMembership"),
      organizationId: fixture.organizationId,
      listId,
      address: `member${i}@example.com`,
      status: "subscribed" as const,
      source: "import" as const,
      doubleOptIn: false,
    })),
  );
});

describe("list detail page", () => {
  it("pages past 200 members and counts all of them", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const props = await render(listId, cursor);
      expect(props.total).toBe(MEMBERS);
      expect(props.members.length).toBeLessThanOrEqual(50);
      for (const member of props.members) seen.add(member.id);
      cursor = props.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 20);

    expect(seen.size).toBe(MEMBERS);
    expect(pages).toBe(5);
  });

  it("shows one quiet page first", async () => {
    const props = await render(listId);
    expect(props.members).toHaveLength(50);
    expect(props.nextCursor).toBe(props.members.at(-1)?.id);
  });

  it("counts members by status and filters to one", async () => {
    const rows = await db.select({ id: listMemberships.id }).from(listMemberships).limit(30);
    await db.update(listMemberships).set({ status: "unsubscribed" }).where(inArray(listMemberships.id, rows.slice(0, 20).map((row) => row.id)));
    await db.update(listMemberships).set({ status: "pending" }).where(inArray(listMemberships.id, rows.slice(20).map((row) => row.id)));

    const all = await render(listId);
    expect(all.counts).toEqual({ subscribed: MEMBERS - 30, pending: 10, unsubscribed: 20 });
    expect(all.total).toBe(MEMBERS);
    expect(all.status).toBeNull();

    const unsubscribed = await render(listId, undefined, "unsubscribed");
    expect(unsubscribed.status).toBe("unsubscribed");
    expect(unsubscribed.members).toHaveLength(20);
    expect(unsubscribed.members.every((member) => member.status === "unsubscribed")).toBe(true);
    expect(unsubscribed.nextCursor).toBeNull();
  });

  it("ignores an unknown status", async () => {
    const props = await render(listId, undefined, "bogus");
    expect(props.status).toBeNull();
    expect(props.members).toHaveLength(50);
  });
});
