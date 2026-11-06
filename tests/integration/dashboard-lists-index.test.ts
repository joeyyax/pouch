import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { listMemberships, lists } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

const sessionState = vi.hoisted(() => ({ organizationId: "" }));

vi.mock("@/lib/dashboard/session", async (importOriginal) =>
  (await import("./fixtures")).dashboardSessionModule(await importOriginal<typeof import("@/lib/dashboard/session")>(), sessionState),
);

const { default: ListsPage } = await import("@/app/(app)/lists/page");

interface IndexProps {
  lists: { id: string }[];
  counts: Record<string, { subscribed: number; pending: number; unsubscribed: number }>;
  total: number;
  nextCursor: string | null;
  paged: boolean;
}

async function render(cursor?: string): Promise<IndexProps> {
  const element = await ListsPage({ searchParams: Promise.resolve(cursor ? { cursor } : {}) });
  return element.props as IndexProps;
}

const LISTS = 230;

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  sessionState.organizationId = fixture.organizationId;
  // One statement, so every row shares a timestamp and only the id orders them.
  await db.insert(lists).values(
    Array.from({ length: LISTS }, (_, i) => ({
      id: newId("list"),
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      name: `List ${i}`,
    })),
  );
});

describe("lists page", () => {
  it("pages past 200 lists and counts all of them", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const props = await render(cursor);
      expect(props.total).toBe(LISTS);
      expect(props.paged).toBe(pages > 0);
      expect(props.lists.length).toBeLessThanOrEqual(50);
      for (const list of props.lists) seen.add(list.id);
      cursor = props.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 20);

    expect(seen.size).toBe(LISTS);
    expect(pages).toBe(5);
  });

  it("counts each list's members by status, zeros included", async () => {
    const [first, second] = (await render()).lists;
    await db.insert(listMemberships).values(
      (["subscribed", "subscribed", "pending"] as const).map((status, i) => ({
        id: newId("listMembership"),
        organizationId: fixture.organizationId,
        listId: first!.id,
        address: `m${i}@example.com`,
        status,
        source: "manual" as const,
        doubleOptIn: false,
      })),
    );

    const { counts } = await render();
    expect(counts[first!.id]).toEqual({ subscribed: 2, pending: 1, unsubscribed: 0 });
    expect(counts[second!.id]).toEqual({ subscribed: 0, pending: 0, unsubscribed: 0 });
  });
});
