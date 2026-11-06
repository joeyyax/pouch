import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, listMemberships } from "@/lib/db/schema";
import { PATCH as listPATCH } from "@/app/api/v1/lists/[id]/route";
import { PATCH as memberPATCH } from "@/app/api/v1/lists/[id]/members/[memberId]/route";
import { POST as membersPOST } from "@/app/api/v1/lists/[id]/members/route";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { userActor } from "@/lib/activity/record";
import { createList } from "@/lib/lists";
import { addMembership } from "@/lib/lists/members";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

function patch(secret: string, body: unknown, path = "lists/x"): Request {
  return new Request(`http://localhost/v1/${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

function listContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function memberContext(id: string, memberId: string) {
  return { params: Promise.resolve({ id, memberId }) };
}

async function seedList(fixture: Fixture, name = "Newsletter", doubleOptIn?: boolean) {
  return createList(
    { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u1", "Test") },
    { domain_id: fixture.domainId, name, ...(doubleOptIn === undefined ? {} : { double_opt_in: doubleOptIn }) },
  );
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
});

describe("PATCH /v1/lists/:id", () => {
  it("renames a list and records the change", async () => {
    const fixture = await seedFixture();
    const list = await seedList(fixture);

    const response = await listPATCH(patch(fixture.secret, { name: "Product news" }), listContext(list.id));
    const body = (await response.json()) as { name: string; double_opt_in: boolean };

    expect(response.status).toBe(200);
    expect(body.name).toBe("Product news");

    const rows = await db.select().from(activity).where(eq(activity.action, "list.updated"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ from: "Newsletter", to: "Product news" });
  });

  it("refuses a name another list on the domain already has", async () => {
    const fixture = await seedFixture();
    await seedList(fixture, "Taken");
    const list = await seedList(fixture, "Newsletter");

    const response = await listPATCH(patch(fixture.secret, { name: "Taken" }), listContext(list.id));
    const body = (await response.json()) as { error: { code: string; field?: string } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.field).toBe("name");
  });

  it("leaves memberships on the opt-in mode they joined under", async () => {
    const fixture = await seedFixture();
    const list = await seedList(fixture, "Newsletter", true);
    const { membership } = await addMembership({
      organizationId: fixture.organizationId,
      listId: list.id,
      address: "ada@example.com",
      source: "manual",
      doubleOptIn: true,
    });
    expect(membership.status).toBe("pending");

    await listPATCH(patch(fixture.secret, { double_opt_in: false }), listContext(list.id));

    const [row] = await db.select().from(listMemberships).where(eq(listMemberships.id, membership.id));
    expect(row?.status).toBe("pending");
    expect(row?.doubleOptIn).toBe(true);
  });

  it("applies the new opt-in mode to the next address added", async () => {
    const fixture = await seedFixture();
    const list = await seedList(fixture, "Newsletter", true);

    await listPATCH(patch(fixture.secret, { double_opt_in: false }), listContext(list.id));

    const response = await membersPOST(
      new Request("http://localhost/v1/lists/x/members", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${fixture.secret}` },
        body: JSON.stringify({ address: "grace@example.com" }),
      }),
      listContext(list.id),
    );
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("subscribed");
  });

  it("refuses an empty patch", async () => {
    const fixture = await seedFixture();
    const list = await seedList(fixture);

    const response = await listPATCH(patch(fixture.secret, {}), listContext(list.id));
    expect(response.status).toBe(422);
  });

  it("won't reach a list outside the key's domain scope", async () => {
    const fixture = await seedFixture();
    const list = await seedList(fixture);
    const other = await seedFixture();

    const response = await listPATCH(patch(other.secret, { name: "Mine now" }), listContext(list.id));
    expect(response.status).toBe(404);
  });
});

describe("PATCH /v1/lists/:id/members/:memberId", () => {
  it("replaces the attribute map and records the change without the address", async () => {
    const fixture = await seedFixture();
    const list = await seedList(fixture, "Newsletter", false);
    const { membership } = await addMembership({
      organizationId: fixture.organizationId,
      listId: list.id,
      address: "ada@example.com",
      source: "manual",
      doubleOptIn: false,
      attributes: { first_name: "Ada", plan: "pro" },
    });

    const response = await memberPATCH(
      patch(fixture.secret, { attributes: { first_name: "Ada Lovelace" } }, `lists/x/members/${membership.id}`),
      memberContext(list.id, membership.id),
    );
    const body = (await response.json()) as { attributes: Record<string, string>; address: string };

    expect(response.status).toBe(200);
    expect(body.attributes).toEqual({ first_name: "Ada Lovelace" });
    expect(body.address).toBe("ada@example.com");

    const [row] = await db.select().from(activity).where(eq(activity.action, "list.member.updated"));
    expect(row?.metadata).toMatchObject({ membershipId: membership.id });
    expect(JSON.stringify(row?.metadata)).not.toContain("ada@example.com");
  });

  it("clears the map with an empty object", async () => {
    const fixture = await seedFixture();
    const list = await seedList(fixture, "Newsletter", false);
    const { membership } = await addMembership({
      organizationId: fixture.organizationId,
      listId: list.id,
      address: "ada@example.com",
      source: "manual",
      doubleOptIn: false,
      attributes: { plan: "pro" },
    });

    await memberPATCH(
      patch(fixture.secret, { attributes: {} }, `lists/x/members/${membership.id}`),
      memberContext(list.id, membership.id),
    );

    const [row] = await db
      .select()
      .from(listMemberships)
      .where(and(eq(listMemberships.id, membership.id), eq(listMemberships.listId, list.id)));
    expect(row?.attributes).toEqual({});
  });

  it("won't change a member on another list", async () => {
    const fixture = await seedFixture();
    const list = await seedList(fixture, "Newsletter", false);
    const other = await seedList(fixture, "Other", false);
    const { membership } = await addMembership({
      organizationId: fixture.organizationId,
      listId: list.id,
      address: "ada@example.com",
      source: "manual",
      doubleOptIn: false,
    });

    const response = await memberPATCH(
      patch(fixture.secret, { attributes: { plan: "free" } }, `lists/x/members/${membership.id}`),
      memberContext(other.id, membership.id),
    );
    expect(response.status).toBe(404);
  });
});
