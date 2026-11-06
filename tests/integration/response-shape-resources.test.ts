import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { batches, memberships } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { userActor } from "@/lib/activity/record";
import { createList } from "@/lib/lists";
import { addMembership } from "@/lib/lists/members";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { GET as listDomains } from "@/app/api/v1/domains/route";
import { GET as readDomain } from "@/app/api/v1/domains/[id]/route";
import { GET as readKey } from "@/app/api/v1/keys/[id]/route";
import { GET as listLists } from "@/app/api/v1/lists/route";
import { GET as readList } from "@/app/api/v1/lists/[id]/route";
import { GET as readBatch } from "@/app/api/v1/batches/[id]/route";
import { GET as listProviders } from "@/app/api/v1/providers/route";
import { GET as readOrganization } from "@/app/api/v1/organization/route";
import { GET as adminUsers } from "@/app/api/v1/admin/users/route";
import { GET as adminMembers } from "@/app/api/v1/admin/organizations/[id]/members/route";
import { seedAdmin } from "./admin-fixtures";
import { resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
});

function get(path: string, secret = fixture.secret): Request {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${secret}` } });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function json(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("fields on resources without expansions", () => {
  it("trims a key to the named fields, keeps its id, and refuses an unknown field", async () => {
    expect(await json(await readKey(get(`/v1/keys/${fixture.key.id}?fields=name,mode`), params(fixture.key.id)))).toEqual({
      id: fixture.key.id,
      name: "test",
      mode: "live",
    });

    // No expansions means no include parameter, and an unknown parameter is ignored like any other.
    expect((await readKey(get(`/v1/keys/${fixture.key.id}?include=secret`), params(fixture.key.id))).status).toBe(200);

    const unknown = await readKey(get(`/v1/keys/${fixture.key.id}?fields=secret`), params(fixture.key.id));
    expect(unknown.status).toBe(422);
    expect(((await unknown.json()) as { error: { field: string } }).error.field).toBe("fields");
  });

  it("works on a singleton", async () => {
    expect(Object.keys(await json(await readOrganization(get("/v1/organization?fields=name"))))).toEqual(["id", "name"]);
  });
});

describe("domains", () => {
  it("keeps standing by default and drops it with fields", async () => {
    const full = await json(await readDomain(get(`/v1/domains/${fixture.domainId}`), params(fixture.domainId)));
    expect(full).toMatchObject({ standing: "healthy", standing_reason: null });

    const trimmed = await json(await readDomain(get(`/v1/domains/${fixture.domainId}?fields=name,status`), params(fixture.domainId)));
    expect(trimmed).toEqual({ id: fixture.domainId, name: "example.com", status: "verified" });

    const page = (await json(await listDomains(get("/v1/domains?fields=name&include=standing")))) as { data: Record<string, unknown>[] };
    expect(Object.keys(page.data[0]!)).toEqual(["id", "name", "standing", "standing_reason"]);
  });
});

describe("lists", () => {
  it("counts members by status only with include=member_counts", async () => {
    const actor = userActor("u1", "Test");
    const list = await createList({ organizationId: fixture.organizationId, domainIds: [], actor }, { domain_id: fixture.domainId, name: "News", double_opt_in: false });
    for (const address of ["a@example.net", "b@example.net"]) {
      await addMembership({ organizationId: fixture.organizationId, listId: list.id, address, source: "manual", doubleOptIn: false });
    }
    await addMembership({ organizationId: fixture.organizationId, listId: list.id, address: "c@example.net", source: "manual", doubleOptIn: true });

    expect(await json(await readList(get(`/v1/lists/${list.id}`), params(list.id)))).not.toHaveProperty("member_counts");
    const counted = await json(await readList(get(`/v1/lists/${list.id}?include=member_counts`), params(list.id)));
    expect(counted.member_counts).toEqual({ pending: 1, subscribed: 2, unsubscribed: 0 });

    const page = (await json(await listLists(get("/v1/lists?include=member_counts&fields=name")))) as { data: Record<string, unknown>[] };
    expect(page.data).toEqual([{ id: list.id, name: "News", member_counts: { pending: 1, subscribed: 2, unsubscribed: 0 } }]);
  });
});

describe("batches", () => {
  it("tallies its messages by status, and skips the tally when fields leaves it out", async () => {
    const batchId = newId("batch");
    await db.insert(batches).values({
      id: batchId,
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      fromAddress: "hi@example.com",
      subject: "Weekly",
      recipientCount: 3,
    });
    for (const status of ["delivered", "delivered", "bounced"] as const) await seedMessage(fixture, { batchId, status });

    expect((await json(await readBatch(get(`/v1/batches/${batchId}`), params(batchId)))).counts).toEqual({ bounced: 1, delivered: 2 });
    expect(await json(await readBatch(get(`/v1/batches/${batchId}?fields=subject`), params(batchId)))).toEqual({ id: batchId, subject: "Weekly" });
  });
});

describe("providers", () => {
  it("reads ready without status loads, and returns status by default", async () => {
    const page = (await json(await listProviders(get("/v1/providers")))) as { data: Record<string, unknown>[] };
    expect(page.data[0]).toHaveProperty("status");
    const trimmed = (await json(await listProviders(get("/v1/providers?fields=name,assigned")))) as { data: Record<string, unknown>[] };
    expect(Object.keys(trimmed.data[0]!)).toEqual(["id", "name", "assigned"]);
  });
});

describe("admin", () => {
  it("drops memberships with fields, and keeps user_id as a member's id", async () => {
    const admin = await seedAdmin();
    await db.insert(memberships).values({ id: newId("membership"), userId: admin.adminUserId, organizationId: admin.organizationId, role: "owner" });
    const users = (await json(await adminUsers(get("/v1/admin/users?fields=email", admin.secret)))) as { data: Record<string, unknown>[] };
    expect(users.data.every((user) => Object.keys(user).join() === "id,email")).toBe(true);

    const members = (await json(await adminMembers(get(`/v1/admin/organizations/${admin.organizationId}/members?fields=role`, admin.secret), params(admin.organizationId)))) as {
      data: Record<string, unknown>[];
    };
    expect(members.data).toEqual([{ user_id: admin.adminUserId, role: "owner" }]);
  });
});
