/**
 * Single-address list changes never write the address into activity (#352). The feed reads it
 * live from the membership or domain stop the row names, so deleting that row takes the address
 * out of the log too.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, domainUnsubscribes, listMemberships } from "@/lib/db/schema";
import { POST } from "@/app/api/v1/lists/[id]/members/route";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { createList, type ListCaller } from "@/lib/lists";
import { addMembership, removeMember } from "@/lib/lists/members";
import { redeemUnsubscribeToken, unsubscribeFromDomain, unsubscribeFromList } from "@/lib/lists/unsubscribe";
import { signSubjectToken } from "@/lib/lists/tokens";
import { userActor } from "@/lib/activity/record";
import { listActivity } from "@/lib/activity/query";
import { groupActivity } from "@/lib/activity/group";
import { detailsFor } from "@/lib/activity/labels";
import type { ActivityListItem } from "@/lib/activity/types";
import { resetDatabase, seedFixture } from "./fixtures";

const ADDRESS = "ada@example.com";
const noFilters = { families: [], outcomes: [], actors: [], since: null };

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
});

async function setup() {
  const fixture = await seedFixture();
  const caller: ListCaller = { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u1", "Ada Admin") };
  const list = await createList(caller, { domain_id: fixture.domainId, name: "Newsletter", double_opt_in: false });
  return { fixture, caller, list };
}

async function storedRow(organizationId: string, action: string) {
  const [row] = await db
    .select()
    .from(activity)
    .where(and(eq(activity.organizationId, organizationId), eq(activity.action, action)));
  if (!row) throw new Error(`no ${action} row`);
  return row;
}

async function feedRow(organizationId: string, action: string): Promise<ActivityListItem> {
  const page = await listActivity(organizationId, noFilters);
  const row = page.rows.find((r) => r.action === action);
  if (!row) throw new Error(`no ${action} row in the feed`);
  return row;
}

function feedDetails(item: ActivityListItem): string[] {
  const [group] = groupActivity([item]);
  if (!group) throw new Error("no group");
  return detailsFor(group);
}

describe("list.member.added (API single add)", () => {
  it("stores the membership id, not the address, and the feed shows the address live", async () => {
    const { fixture, list } = await setup();
    const response = await POST(
      new Request("http://localhost/v1/lists/x/members", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${fixture.secret}` },
        body: JSON.stringify({ address: ADDRESS }),
      }),
      { params: Promise.resolve({ id: list.id }) },
    );
    expect(response.status).toBe(201);
    const member = (await response.json()) as { id: string };

    const stored = await storedRow(fixture.organizationId, "list.member.added");
    expect(JSON.stringify(stored)).not.toContain(ADDRESS);
    expect(stored.metadata).toMatchObject({ membershipId: member.id });

    const item = await feedRow(fixture.organizationId, "list.member.added");
    expect(item.subjectLabel).toBe("Newsletter");
    expect(feedDetails(item)).toContain(ADDRESS);

    // Deleting the membership is the purge: nothing in the feed still carries the address.
    await db.delete(listMemberships).where(eq(listMemberships.id, member.id));
    const after = await feedRow(fixture.organizationId, "list.member.added");
    expect(JSON.stringify(after)).not.toContain(ADDRESS);
    expect(feedDetails(after)).toEqual(expect.arrayContaining([expect.stringContaining(member.id)]));
  });
});

describe("list.member.removed", () => {
  it("stores no address and the feed names the removed member by id", async () => {
    const { fixture, caller, list } = await setup();
    const { membership } = await addMembership({
      organizationId: fixture.organizationId,
      listId: list.id,
      address: ADDRESS,
      source: "manual",
      doubleOptIn: false,
    });

    await removeMember(caller, list.id, membership.id, caller.actor);

    const stored = await storedRow(fixture.organizationId, "list.member.removed");
    expect(JSON.stringify(stored)).not.toContain(ADDRESS);
    expect(stored.metadata).toMatchObject({ membershipId: membership.id });

    const item = await feedRow(fixture.organizationId, "list.member.removed");
    expect(JSON.stringify(item)).not.toContain(ADDRESS);
    expect(item.subjectLabel).toBe("Newsletter");
    expect(feedDetails(item)).toEqual(expect.arrayContaining([expect.stringContaining(membership.id)]));
  });
});

describe("list.unsubscribed", () => {
  it("stores the membership id and reads the address back while the membership exists", async () => {
    const { fixture, caller, list } = await setup();
    await unsubscribeFromList(caller, list.id, ADDRESS);

    const [membership] = await db.select().from(listMemberships).where(eq(listMemberships.listId, list.id));
    expect(membership?.status).toBe("unsubscribed");

    const stored = await storedRow(fixture.organizationId, "list.unsubscribed");
    expect(JSON.stringify(stored)).not.toContain(ADDRESS);
    expect(stored.metadata).toMatchObject({ membershipId: membership?.id });

    const item = await feedRow(fixture.organizationId, "list.unsubscribed");
    expect(item.address).toBe(ADDRESS);
    expect(feedDetails(item)).toContain(ADDRESS);
  });
});

describe("domain.unsubscribed", () => {
  it("stores the domain stop's id and reads the address back from it", async () => {
    const { fixture, caller } = await setup();
    await unsubscribeFromDomain(caller, fixture.domainId, ADDRESS);
    // A repeat hits the existing stop and still records a reference to it.
    await unsubscribeFromDomain(caller, fixture.domainId, ADDRESS);

    const [stop] = await db.select().from(domainUnsubscribes).where(eq(domainUnsubscribes.domainId, fixture.domainId));
    if (!stop) throw new Error("no domain stop");

    const rows = await db.select().from(activity).where(eq(activity.action, "domain.unsubscribed"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(ADDRESS);
      expect(row.metadata).toMatchObject({ domainUnsubscribeId: stop.id });
    }

    const item = await feedRow(fixture.organizationId, "domain.unsubscribed");
    expect(item.subjectLabel).toBe("example.com");
    expect(feedDetails(item)).toContain(ADDRESS);

    await db.delete(domainUnsubscribes).where(eq(domainUnsubscribes.id, stop.id));
    const after = await listActivity(fixture.organizationId, noFilters);
    expect(JSON.stringify(after)).not.toContain(ADDRESS);
  });
});

describe("recipient-facing unsubscribe", () => {
  it("still unsubscribes from the list and the domain by token", async () => {
    const { fixture, list } = await setup();
    const { membership } = await addMembership({
      organizationId: fixture.organizationId,
      listId: list.id,
      address: ADDRESS,
      source: "manual",
      doubleOptIn: false,
    });

    const result = await redeemUnsubscribeToken(signSubjectToken(membership.id, "unsubscribe"), "domain");
    expect(result).toEqual({ scope: "domain", list_name: null, domain_name: "example.com" });

    const [row] = await db.select().from(listMemberships).where(eq(listMemberships.id, membership.id));
    expect(row?.status).toBe("unsubscribed");
    const stops = await db.select().from(domainUnsubscribes).where(eq(domainUnsubscribes.address, ADDRESS));
    expect(stops).toHaveLength(1);
  });
});
