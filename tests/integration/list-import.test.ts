import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { activity, listMemberships } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { POST } from "@/app/api/v1/lists/[id]/members/route";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { createList } from "@/lib/lists";
import { userActor } from "@/lib/activity/record";
import { resetDatabase, routeContext, seedFixture } from "./fixtures";

function jsonRequest(secret: string, body: unknown): Request {
  return new Request("http://localhost/v1/lists/x/members", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

function csvRequest(secret: string, csv: string): Request {
  return new Request("http://localhost/v1/lists/x/members", {
    method: "POST",
    headers: { "content-type": "text/csv", authorization: `Bearer ${secret}` },
    body: csv,
  });
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
});

describe("POST /v1/lists/:id/members — import", () => {
  it("imports a JSON members array, reporting a bad row instead of failing the batch", async () => {
    const fixture = await seedFixture();
    const list = await createList(
      { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u1", "Test") },
      { domain_id: fixture.domainId, name: "Newsletter" },
    );

    const response = await POST(
      jsonRequest(fixture.secret, { members: [{ address: "ada@example.com" }, { address: "not-an-address" }] }),
      routeContext(list.id),
    );
    const body = (await response.json()) as { imported: { address: string }[]; errors: { line: number | null; message: string }[] };

    expect(response.status).toBe(200);
    expect(body.imported).toHaveLength(1);
    expect(body.imported[0]?.address).toBe("ada@example.com");
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]?.line).toBeNull();
  });

  it("imports a CSV file, reporting the failing line instead of aborting the file", async () => {
    const fixture = await seedFixture();
    const list = await createList(
      { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u1", "Test") },
      { domain_id: fixture.domainId, name: "Newsletter" },
    );

    const csv = "address,plan\nada@example.com,pro\n,pro\ngrace@example.com,free\n";
    const response = await POST(csvRequest(fixture.secret, csv), routeContext(list.id));
    const body = (await response.json()) as { imported: { address: string }[]; errors: { line: number; message: string }[] };

    expect(response.status).toBe(200);
    expect(body.imported.map((m) => m.address).sort()).toEqual(["ada@example.com", "grace@example.com"]);
    expect(body.errors).toEqual([{ line: 3, address: "", message: "Address is required." }]);

    const rows = await db.select().from(listMemberships).where(eq(listMemberships.listId, list.id));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.address === "ada@example.com")?.attributes).toEqual({ plan: "pro" });
  });

  it("marks a CSV row confirmed: true as confirmed by import, skipping double opt-in for it", async () => {
    const fixture = await seedFixture();
    const list = await createList(
      { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u1", "Test") },
      { domain_id: fixture.domainId, name: "Newsletter", double_opt_in: true },
    );

    const csv = "address,confirmed\nada@example.com,true\ngrace@example.com,false\n";
    await POST(csvRequest(fixture.secret, csv), routeContext(list.id));

    const rows = await db.select().from(listMemberships).where(eq(listMemberships.listId, list.id));
    const ada = rows.find((r) => r.address === "ada@example.com");
    const grace = rows.find((r) => r.address === "grace@example.com");
    expect(ada?.status).toBe("subscribed");
    expect(ada?.confirmedBy).toBe("import");
    expect(grace?.status).toBe("pending");
  });

  it("round-trips a list's own CSV export back in as an import", async () => {
    const fixture = await seedFixture();
    const list = await createList(
      { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u1", "Test") },
      { domain_id: fixture.domainId, name: "Newsletter", double_opt_in: false },
    );
    await POST(jsonRequest(fixture.secret, { members: [{ address: "ada@example.com", attributes: { plan: "pro" } }] }), routeContext(list.id));

    const { GET: exportRoute } = await import("@/app/api/v1/lists/[id]/export/route");
    const exportResponse = await exportRoute(
      new Request("http://localhost/v1/lists/x/export", { headers: { authorization: `Bearer ${fixture.secret}` } }),
      routeContext(list.id),
    );
    const csv = await exportResponse.text();

    const list2 = await createList(
      { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u1", "Test") },
      { domain_id: fixture.domainId, name: "Newsletter 2", double_opt_in: false },
    );
    const importResponse = await POST(csvRequest(fixture.secret, csv), routeContext(list2.id));
    const body = (await importResponse.json()) as { imported: { address: string }[]; errors: unknown[] };

    expect(body.errors).toEqual([]);
    expect(body.imported.map((m) => m.address)).toEqual(["ada@example.com"]);
  });
});

describe("POST /v1/lists/:id/members — import activity", () => {
  async function importActivity(organizationId: string) {
    return db.select().from(activity).where(eq(activity.organizationId, organizationId));
  }

  it("records one summary row with counts and no addresses", async () => {
    const fixture = await seedFixture();
    const list = await createList(
      { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u1", "Test") },
      { domain_id: fixture.domainId, name: "Newsletter", double_opt_in: false },
    );
    await POST(jsonRequest(fixture.secret, { members: [{ address: "ada@example.com" }] }), routeContext(list.id));

    const csv = "address\nada@example.com\ngrace@example.com\nlin@example.com\nnope\n";
    const response = await POST(csvRequest(fixture.secret, csv), routeContext(list.id));
    expect(response.status).toBe(200);

    const rows = await importActivity(fixture.organizationId);
    const imports = rows.filter((row) => row.action !== "list.created");
    expect(imports.map((row) => row.action)).toEqual(["list.members.imported", "list.members.imported"]);
    const latest = imports.find((row) => (row.metadata as { added?: number }).added === 2);
    expect(latest?.appliesTo).toBe(list.id);
    expect(latest?.metadata).toEqual({ added: 2, already_present: 1, invalid: 1 });
    expect(JSON.stringify(rows)).not.toMatch(/@example\.com/);
  });

  it("reports added, already present and invalid counts beside the imported rows", async () => {
    const fixture = await seedFixture();
    const list = await createList(
      { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u1", "Test") },
      { domain_id: fixture.domainId, name: "Newsletter", double_opt_in: false },
    );
    await POST(jsonRequest(fixture.secret, { members: [{ address: "ada@example.com" }] }), routeContext(list.id));

    const json = await POST(
      jsonRequest(fixture.secret, { members: [{ address: "ada@example.com" }, { address: "grace@example.com" }, { address: "nope" }] }),
      routeContext(list.id),
    );
    const jsonBody = (await json.json()) as Record<string, unknown> & { imported: unknown[] };
    expect(jsonBody).toMatchObject({ added: 1, already_present: 1, invalid: 1 });
    expect(jsonBody.imported).toHaveLength(2);

    const csv = await POST(csvRequest(fixture.secret, "address\ngrace@example.com\nlin@example.com\n"), routeContext(list.id));
    expect(await csv.json()).toMatchObject({ added: 1, already_present: 1, invalid: 0 });
  });

  it("records nothing when an import adds no one", async () => {
    const fixture = await seedFixture();
    const list = await createList(
      { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u1", "Test") },
      { domain_id: fixture.domainId, name: "Newsletter", double_opt_in: false },
    );
    await POST(jsonRequest(fixture.secret, { members: [{ address: "ada@example.com" }] }), routeContext(list.id));
    await POST(jsonRequest(fixture.secret, { members: [{ address: "ada@example.com" }, { address: "nope" }] }), routeContext(list.id));

    const rows = await importActivity(fixture.organizationId);
    const imports = rows.filter((row) => row.action === "list.members.imported");
    expect(imports).toHaveLength(1);
    expect(imports[0]?.metadata).toEqual({ added: 1, already_present: 0, invalid: 0 });
  });
});
