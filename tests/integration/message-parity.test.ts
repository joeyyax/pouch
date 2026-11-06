import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, inboundMessages, messages } from "@/lib/db/schema";
import { newMessageKey } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { newStorageKey } from "@/lib/storage/bodies";
import type { DomainLayout } from "@/lib/domains/layout";
import { acceptMessage } from "@/lib/messages/create";
import { recordEvent, recordOccurrence } from "@/lib/messages/events";
import { claimMessages, dueProviders } from "@/lib/messages/queue";
import { mockSends, resetMockSends } from "@/lib/providers/adapters/mock";
import { deliver } from "@/worker/send";
import { stallDomain } from "@/lib/domains/stall";
import { DEFAULT_STALL_LINES } from "@/lib/domains/guard";
import { dbNow } from "@/lib/db/clock";
import { readMessage, readMessageBody } from "@/lib/dashboard/messages";
import { GET as listEmails } from "@/app/api/v1/emails/route";
import { GET as readEmail } from "@/app/api/v1/emails/[id]/route";
import { GET as listInbound } from "@/app/api/v1/inbound/route";
import { resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const layout: DomainLayout = { brandName: "Scope", logoUrl: null, accent: "#1d46f5", footer: "Scope · Portland, OR" };

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetMockSends();
  fixture = await seedFixture({ scopeToDomain: false });
});

function get(path: string): Request {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${fixture.secret}` } });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function read(id: string, query = ""): Promise<Record<string, unknown>> {
  return (await (await readEmail(get(`/v1/emails/${id}${query}`), params(id))).json()) as Record<string, unknown>;
}

async function list(query: string): Promise<string[]> {
  const page = (await (await listEmails(get(`/v1/emails${query}`))).json()) as { data: { id: string }[] };
  return page.data.map((message) => message.id);
}

async function send(extra: { layout?: boolean | { footer: string }; headers?: Record<string, string> } = {}) {
  const { message } = await acceptMessage(
    fixture.key,
    { from: "Ada <ada@example.com>", to: ["sam@example.com"], subject: "Your invite", html: "<p>Your invite is ready.</p>", ...extra },
    null,
  );
  return message.id;
}

async function deliverAll(): Promise<void> {
  for (const provider of await dueProviders()) {
    for (const claimed of await claimMessages({ workerId: "worker-test", providerId: provider.id, limit: 10 })) await deliver(claimed);
  }
}

describe("what the dashboard shows, on the message", () => {
  it("returns headers, the layout as asked and the batch by default", async () => {
    await db.update(domains).set({ layout }).where(eq(domains.id, fixture.domainId));
    const plain = await send({ headers: { "X-Entity-Ref": "inv_42" } });
    const framed = await send({ layout: true });
    const overridden = await send({ layout: { footer: "Just this once" } });
    const batched = await seedMessage(fixture, { batchId: "bat_1" });

    expect(await read(plain)).toMatchObject({ headers: { "X-Entity-Ref": "inv_42" }, layout: false, batch_id: null });
    expect((await read(framed)).layout).toBe(true);
    expect((await read(overridden)).layout).toEqual({ footer: "Just this once" });
    expect((await read(batched)).batch_id).toBe("bat_1");
  });

  it("says when a queued message is next tried, and nothing once it's out of the worker's hands", async () => {
    const queued = await seedMessage(fixture, { status: "queued", nextAttemptAt: new Date("2026-10-02T12:00:00Z") });
    const deferred = await seedMessage(fixture, { status: "deferred", nextAttemptAt: new Date("2026-10-01T12:00:00Z") });
    const abandonedAt = new Date("2026-10-01T09:00:00Z");
    const abandoned = await seedMessage(fixture, { status: "sent", abandonedAt });

    expect((await read(queued)).next_attempt_at).toBe("2026-10-02T12:00:00.000Z");
    expect((await read(deferred)).next_attempt_at).toBeNull();
    expect(await read(abandoned)).toMatchObject({ status: "sent", abandoned_at: abandonedAt.toISOString(), next_attempt_at: null });
  });
});

describe("filters on GET /v1/emails", () => {
  it("takes a list of statuses, and one status as before", async () => {
    const bounced = await seedMessage(fixture, { status: "bounced" });
    const failed = await seedMessage(fixture, { status: "failed" });
    await seedMessage(fixture, { status: "delivered" });

    expect((await list("?status=bounced,failed")).sort()).toEqual([bounced, failed].sort());
    expect(await list("?status=bounced")).toEqual([bounced]);

    const refused = await listEmails(get("/v1/emails?status=bounced,lost"));
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: { field: string; detail: { unknown: string[] } } }).error).toMatchObject({
      field: "status",
      detail: { unknown: ["lost"] },
    });
  });

  it("narrows to one batch", async () => {
    const inBatch = await seedMessage(fixture, { batchId: "bat_1" });
    await seedMessage(fixture, { batchId: "bat_2" });
    await seedMessage(fixture);
    expect(await list("?batch=bat_1")).toEqual([inBatch]);
  });

  it("splits held from everything else", async () => {
    const queued = await seedMessage(fixture, { status: "queued" });
    const delivered = await seedMessage(fixture, { status: "delivered" });
    expect(await list("?held=true")).toEqual([]);

    const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    await stallDomain(domain!, { reason: "bounce_count", detail: { metric: "bounce", count: 3, denominator: 5, rate: 0.6, previousRate: 0, threshold: DEFAULT_STALL_LINES.bounce.stall } }, await dbNow());

    expect(await list("?held=true")).toEqual([queued]);
    expect(await list("?held=false")).toEqual([delivered]);
  });

  it("selects only the columns a narrow read needs and still builds the keys it names", async () => {
    await seedMessage(fixture, { status: "bounced", to: "sam@example.com" });
    const page = (await (await listEmails(get("/v1/emails?fields=to,status"))).json()) as { data: Record<string, unknown>[] };
    expect(page.data).toEqual([{ id: expect.any(String), to: ["sam@example.com"], status: "bounced" }]);
  });
});

describe("GET /v1/inbound?outbound_message", () => {
  it("lists only the replies to that send", async () => {
    const sent = await seedMessage(fixture);
    const reply = newId("inbound");
    for (const [id, outboundMessageId] of [
      [reply, sent],
      [newId("inbound"), null],
    ] as const) {
      await db.insert(inboundMessages).values({
        id,
        organizationId: fixture.organizationId,
        domainId: fixture.domainId,
        fromAddress: "sam@example.com",
        to: ["reply@inbound.example.com"],
        subject: "Re: Your invite",
        attachments: [],
        outboundMessageId,
        threadId: newId("thread"),
        receivedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    }

    const page = (await (await listInbound(get(`/v1/inbound?outbound_message=${sent}&fields=subject`))).json()) as { data: { id: string }[] };
    expect(page.data.map((message) => message.id)).toEqual([reply]);
  });
});

describe("include=occurrences", () => {
  it("returns what happened without a status change, oldest first, and keeps events to transitions", async () => {
    const id = await seedMessage(fixture, { status: "delivered" });
    const at = (seconds: number) => new Date(Date.UTC(2026, 9, 2, 12, 0, seconds));
    await recordEvent({ organizationId: fixture.organizationId, messageId: id, status: "queued", occurredAt: at(0) });
    await recordOccurrence({
      organizationId: fixture.organizationId,
      messageId: id,
      kind: "retry",
      reason: "421 try later",
      detail: { attempt: 1, nextAttemptAt: at(30).toISOString() },
      occurredAt: at(1),
    });
    await recordEvent({ organizationId: fixture.organizationId, messageId: id, status: "sent", occurredAt: at(30) });
    await recordEvent({ organizationId: fixture.organizationId, messageId: id, status: "delivered", occurredAt: at(40) });
    await recordOccurrence({
      organizationId: fixture.organizationId,
      messageId: id,
      kind: "webhook_delivered",
      detail: { eventType: "email.delivered", url: "https://hooks.example.net/pouch?token=secret", statusCode: 200 },
      occurredAt: at(40),
    });

    const body = (await read(id, "?include=occurrences")) as {
      events: { status: string }[];
      occurrences: { kind: string; reason: string | null; detail: Record<string, unknown> }[];
    };
    expect(body.events.map((event) => event.status)).toEqual(["queued", "sent", "delivered"]);
    expect(body.occurrences).toMatchObject([
      { kind: "retry", reason: "421 try later", detail: { attempt: 1, next_attempt_at: at(30).toISOString() } },
      { kind: "webhook_delivered", detail: { event_type: "email.delivered", host: "hooks.example.net", status_code: 200 } },
    ]);
    expect(JSON.stringify(body)).not.toContain("token=secret");
    expect(Object.keys(await read(id))).not.toContain("occurrences");

    // The dashboard's timeline reads the same rows in the same order, newest first.
    const detail = await readMessage(fixture.organizationId, id);
    expect(detail!.events.map((event) => event.status ?? event.kind)).toEqual(["webhook_delivered", "delivered", "sent", "retry", "queued"]);
  });
});

describe("include=rendered", () => {
  it("is what the provider was handed, and says when the layout has changed since", async () => {
    await db.update(domains).set({ layout }).where(eq(domains.id, fixture.domainId));
    const id = await send({ layout: { footer: "Just this once" } });
    await deliverAll();
    const sent = mockSends().at(-1)!.message.html;

    const body = (await read(id, "?include=rendered")) as { rendered: Record<string, unknown>; body_unavailable: unknown; body?: unknown };
    expect(body.rendered).toEqual({ html: sent, framed: true, frame_changed: false });
    expect(body.body_unavailable).toBeNull();
    expect(body).not.toHaveProperty("body");

    await db.update(domains).set({ layout: { ...layout, accent: "#c2410c" } }).where(eq(domains.id, fixture.domainId));
    expect(((await read(id, "?include=rendered")) as { rendered: { frame_changed: boolean } }).rendered.frame_changed).toBe(true);
  });

  it("leaves an unframed send as accepted, and says why when the body is gone", async () => {
    const id = await send();
    expect(((await read(id, "?include=rendered")) as { rendered: unknown }).rendered).toEqual({
      html: "<p>Your invite is ready.</p>",
      framed: false,
      frame_changed: false,
    });

    await db.update(messages).set({ bodyKey: null, bodyPurgedAt: new Date() }).where(eq(messages.id, id));
    expect(await read(id, "?include=rendered")).toMatchObject({ rendered: null, body_unavailable: { reason: "shredded" } });
  });

  it("works on the list with only the columns it needs", async () => {
    const id = await send();
    const page = (await (await listEmails(get("/v1/emails?fields=status&include=rendered"))).json()) as { data: Record<string, unknown>[] };
    expect(page.data).toEqual([{ id, status: "queued", rendered: { html: "<p>Your invite is ready.</p>", framed: false, frame_changed: false }, body_unavailable: null }]);
  });
});

describe("the dashboard's message detail", () => {
  it("opens without reading the body, and the body tab reads it through the same rendering", async () => {
    // A body key with no object behind it: any storage read reports it unavailable.
    const id = await seedMessage(fixture, { storageKey: newStorageKey(), bodyKey: newMessageKey().encoded });
    const detail = await readMessage(fixture.organizationId, id);
    expect(detail).not.toBeNull();
    expect(detail).not.toHaveProperty("body");
    expect(detail!.api.plain.response).not.toContain("body_unavailable");

    expect((await readMessageBody(fixture.organizationId, id))?.body.state).toBe("unavailable");
  });

  it("frames the body tab the way the API's rendered does", async () => {
    await db.update(domains).set({ layout }).where(eq(domains.id, fixture.domainId));
    const id = await send({ layout: true });
    const view = await readMessageBody(fixture.organizationId, id);
    const api = (await read(id, "?include=rendered")) as { rendered: { html: string } };
    expect(view).toMatchObject({ framed: true, frameChanged: false, body: { state: "available", html: api.rendered.html } });
  });

  it("shows a next retry only while one is ahead", async () => {
    const ahead = new Date(Date.now() + 60_000);
    const retrying = await seedMessage(fixture, { status: "queued", attempts: 1, nextAttemptAt: ahead });
    const due = await seedMessage(fixture, { status: "queued", nextAttemptAt: new Date(Date.now() - 1000) });
    const deferred = await seedMessage(fixture, { status: "deferred", nextAttemptAt: ahead });

    expect((await readMessage(fixture.organizationId, retrying))?.nextAttemptAt?.toISOString()).toBe(ahead.toISOString());
    expect((await readMessage(fixture.organizationId, due))?.nextAttemptAt).toBeNull();
    expect((await readMessage(fixture.organizationId, deferred))?.nextAttemptAt).toBeNull();
  });

  it("reads nothing outside the organization", async () => {
    const other = await seedFixture();
    const id = await seedMessage(other);
    expect(await readMessageBody(fixture.organizationId, id)).toBeNull();
  });
});
