import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { domainUnsubscribes, listMemberships, lists } from "@/lib/db/schema";
import { GET } from "@/app/api/v1/recipients/[address]/route";
import { applyEvent } from "@/lib/messages/events";
import { touchFirstSeen } from "@/lib/messages/history";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { createApiKey } from "@/lib/api/key-lifecycle";
import { readRecipients } from "@/lib/recipients";
import { selectShape } from "@/lib/api/shape";
import { recipientShape } from "@/lib/schemas/shapes";
import { newId } from "@/lib/ids";
import { addSuppression, eventSource, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

function read(secret: string, address: string, query = ""): Promise<Response> {
  return GET(
    new Request(`http://localhost/v1/recipients/${encodeURIComponent(address)}${query}`, {
      headers: { authorization: `Bearer ${secret}` },
    }),
    { params: Promise.resolve({ address }) },
  );
}

/** A message to `address`, then the provider's hard bounce on it. */
async function bounce(on: Fixture, address: string): Promise<string> {
  const messageId = await seedMessage(on, { to: address, status: "sent", providerId: on.providerId, providerMessageId: `pm-${address}` });
  await touchFirstSeen(on.organizationId, [address]);
  await applyEvent(eventSource(on), {
    providerMessageId: `pm-${address}`,
    providerEventId: `ev-${address}`,
    status: "bounced",
    reason: "smtp; 550 5.1.1 user unknown",
    bounceType: "Permanent/NoEmail",
    occurredAt: new Date(),
    detail: {},
    recipients: [address],
  });
  return messageId;
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
});

describe("GET /v1/recipients/:address", () => {
  it("returns the address's counts, rollup and the suppression its bounce caused", async () => {
    await seedMessage(fixture, { to: "ada@example.net", status: "delivered" });
    const bounced = await bounce(fixture, "ada@example.net");

    const response = await read(fixture.secret, "ada@example.net");
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toMatchObject({
      address: "ada@example.net",
      last_status: "bounced",
      domain_ids: [fixture.domainId],
      messages: { total: 2, delivered: 1, bounced: 1, complained: 0, failed: 0 },
      bounce_count: 1,
      complaint_count: 0,
      unsubscribes: { lists: [], domains: [] },
      suppression: {
        address: "ada@example.net",
        reason: "hard_bounce",
        bounce_type: "Permanent/NoEmail",
        source_message_id: bounced,
        added_by: null,
        source_message: { id: bounced, domain_id: fixture.domainId, status: "bounced", test_mode: false },
      },
    });
    expect(body.first_seen_at).toEqual(expect.any(String));
    expect(body.last_bounced_at).toEqual(expect.any(String));
    expect(body).not.toHaveProperty("history");
  });

  it("matches on the normalized form, the way a send does", async () => {
    await seedMessage(fixture, { to: "Ada@example.net" });

    const body = await (await read(fixture.secret, "Ada@EXAMPLE.net")).json();

    expect(body.address).toBe("Ada@example.net");
    expect(body.messages.total).toBe(1);
  });

  it("adds history and incidents on include, newest first", async () => {
    const older = await seedMessage(fixture, { to: "ada@example.net", createdAt: new Date(Date.now() - 60_000) });
    const bounced = await bounce(fixture, "ada@example.net");

    const body = await (await read(fixture.secret, "ada@example.net", "?include=history")).json();

    expect(body.history.map((item: { id: string }) => item.id)).toEqual([bounced, older]);
    expect(body.incidents.map((item: { id: string }) => item.id)).toEqual([bounced]);
  });

  it("trims to fields and keeps the address", async () => {
    await seedMessage(fixture, { to: "ada@example.net" });

    const body = await (await read(fixture.secret, "ada@example.net", "?fields=messages")).json();

    expect(Object.keys(body).sort()).toEqual(["address", "messages"]);
  });

  it("lists the lists and domains it unsubscribed from", async () => {
    const listId = newId("list");
    await db.insert(lists).values({ id: listId, organizationId: fixture.organizationId, domainId: fixture.domainId, name: "News" });
    await db.insert(listMemberships).values({
      id: newId("listMembership"),
      organizationId: fixture.organizationId,
      listId,
      address: "ada@example.net",
      status: "unsubscribed",
      source: "manual",
      doubleOptIn: false,
      unsubscribedAt: new Date(),
    });
    await db.insert(domainUnsubscribes).values({
      id: newId("domainUnsubscribe"),
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      address: "ada@example.net",
    });

    const body = await (await read(fixture.secret, "ada@example.net")).json();

    expect(body.messages.total).toBe(0);
    expect(body.unsubscribes.lists).toEqual([{ list_id: listId, unsubscribed_at: expect.any(String) }]);
    expect(body.unsubscribes.domains).toEqual([{ domain_id: fixture.domainId, unsubscribed_at: expect.any(String) }]);
  });

  it("reads an address that's only suppressed", async () => {
    await addSuppression(fixture.organizationId, "ada@example.net");

    const body = await (await read(fixture.secret, "ada@example.net")).json();

    expect(body.first_seen_at).toBeNull();
    expect(body.suppression).toMatchObject({ reason: "hard_bounce", source_message: null });
  });

  it("answers 404 for an address with nothing on file, and 422 for one that isn't an address", async () => {
    expect((await read(fixture.secret, "nobody@example.net")).status).toBe(404);
    const invalid = await read(fixture.secret, "not-an-address");
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).error.field).toBe("address");
  });

  it("leaves out another organization's mail", async () => {
    const other = await seedFixture({ scopeToDomain: false });
    await seedMessage(other, { to: "ada@example.net" });

    expect((await read(fixture.secret, "ada@example.net")).status).toBe(404);
  });

  it("refuses a domain-scoped key and a test key", async () => {
    await seedMessage(fixture, { to: "ada@example.net" });
    const scoped = await seedFixture();
    const test = await createApiKey({ organizationId: fixture.organizationId, name: "test", mode: "test", domainIds: [] });

    expect((await read(scoped.secret, "ada@example.net")).status).toBe(403);
    const refused = await read(test.secret, "ada@example.net");
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("key_not_scoped");
  });
});

describe("readRecipients", () => {
  it("reads several addresses at once and skips the ones with nothing on file", async () => {
    await seedMessage(fixture, { to: ["ada@example.net", "grace@example.net"] });

    const found = await readRecipients({ organizationId: fixture.organizationId, domainIds: [] }, [
      "ada@example.net",
      "grace@example.net",
      "nobody@example.net",
    ], selectShape(recipientShape, { fields: ["messages"] }));

    expect([...found.keys()].sort()).toEqual(["ada@example.net", "grace@example.net"]);
    expect(found.get("grace@example.net")?.messages.total).toBe(1);
  });
});
