import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { listMemberships } from "@/lib/db/schema";
import { userActor } from "@/lib/activity/record";
import { createList } from "@/lib/lists";
import { resetDatabase, routeContext, seedFixture, type Fixture } from "./fixtures";

const sessionState = vi.hoisted(() => ({ organizationId: "" }));

vi.mock("@/lib/dashboard/session", async (importOriginal) =>
  (await import("./fixtures")).dashboardSessionModule(await importOriginal<typeof import("@/lib/dashboard/session")>(), sessionState),
);

const { POST } = await import("@/app/api/dashboard/lists/[id]/import/route");
const { GET } = await import("@/app/api/dashboard/lists/[id]/export/route");

function upload(listId: string, csv: string, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) {
  return POST(
    new Request(`http://localhost:3100/api/dashboard/lists/${listId}/import`, {
      method: "POST",
      headers: { "content-type": "text/csv", ...headers },
      body: csv,
    }),
    routeContext(listId),
  );
}

let fixture: Fixture;
let listId: string;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  sessionState.organizationId = fixture.organizationId;
  const list = await createList(
    { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u1", "Test") },
    { domain_id: fixture.domainId, name: "Café \"news\"", double_opt_in: false },
  );
  listId = list.id;
});

describe("dashboard list CSV", () => {
  it("imports an uploaded file and reports invalid rows by line", async () => {
    const response = await upload(listId, "address,plan\nada@example.com,pro\nnope,pro\n");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      added: 1,
      already_present: 0,
      invalid: 1,
      errors: [{ line: 3, address: "nope", message: '"nope" isn\'t a valid address.' }],
    });
  });

  it("counts members already on the list apart from new ones", async () => {
    await upload(listId, "address\nada@example.com\n");
    const response = await upload(listId, "address\nada@example.com\ngrace@example.com\nnope\n");
    expect(await response.json()).toMatchObject({ added: 1, already_present: 1, invalid: 1 });
  });

  it("refuses an upload from another site", async () => {
    const response = await upload(listId, "address\nada@example.com\n", { "sec-fetch-site": "cross-site" });
    expect(response.status).toBe(401);
    expect(await db.select().from(listMemberships).where(eq(listMemberships.listId, listId))).toHaveLength(0);
  });

  it("exports with the session alone, under a safe filename", async () => {
    await upload(listId, "address,plan\nada@example.com,pro\n");
    const response = await GET(new Request(`http://localhost:3100/api/dashboard/lists/${listId}/export`), routeContext(listId));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="Caf news.csv"; filename*=UTF-8''${encodeURIComponent('Café "news".csv')}`,
    );
    expect(await response.text()).toContain("ada@example.com,subscribed,import,");
  });

  it("won't reach another organization's list", async () => {
    const other = await seedFixture();
    sessionState.organizationId = other.organizationId;

    expect((await GET(new Request("http://localhost:3100/x"), routeContext(listId))).status).toBe(404);
    expect((await upload(listId, "address\nada@example.com\n")).status).toBe(404);
  });
});
