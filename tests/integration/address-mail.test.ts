import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { addresses, domains, messages, providers } from "@/lib/db/schema";
import { ingestInboundMessages } from "@/lib/inbound/ingest";
import { replyHeaders } from "@/lib/inbound/threading";
import { createApiKey } from "@/lib/api/key-lifecycle";
import { acquireStreamSlot, maxConcurrentStreams, resetRateLimitMemory } from "@/lib/api/rate-limit";
import { resetDnsCheckCache } from "@/lib/domains/dns-check";
import { buildMime } from "@/lib/providers/adapters/mime";
import { closeRedis } from "@/lib/redis";
import { newId } from "@/lib/ids";
import type { NormalizedInboundMessage } from "@/lib/providers/adapters/types";
import { POST as createRoute } from "@/app/api/v1/addresses/route";
import { DELETE as revokeRoute } from "@/app/api/v1/addresses/[id]/route";
import { GET as messagesRoute } from "@/app/api/v1/addresses/[id]/messages/route";
import { POST as replyRoute } from "@/app/api/v1/addresses/[id]/reply/route";
import { POST as sendRoute } from "@/app/api/v1/emails/route";
import { addDomainKey, addSuppression, apiRequest, resetDatabase, routeContext, seedFixture, type Fixture } from "./fixtures";
import { testRedisUrl } from "../redis";

const dmarc = vi.hoisted(() => new Map<string, string[]>());
vi.mock("node:dns/promises", () => {
  class Resolver {
    setServers() {}
    cancel() {}
    async resolveTxt(name: string): Promise<string[][]> {
      const records = dmarc.get(name);
      if (!records) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return records.map((record) => [record]);
    }
  }
  return { Resolver, lookup: () => Promise.resolve([{ address: "203.0.113.9", family: 4 }]) };
});

const REDIS_URL = testRedisUrl();

let fixture: Fixture;

interface Page {
  data: { id: string; thread_id: string; address_ids: string[]; subject: string }[];
  next_cursor: string | null;
}

async function call(response: Promise<Response>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function errorOf(body: Record<string, unknown>): { code?: string; detail?: { reason?: string; status?: string } } {
  return (body.error ?? {}) as { code?: string; detail?: { reason?: string; status?: string } };
}

async function createAddress(localPart?: string, secret = fixture.secret): Promise<{ id: string; address: string }> {
  const { status, body } = await call(
    createRoute(apiRequest(secret, "/v1/addresses", "POST", { domain_id: fixture.domainId, expires_in: 3600, ...(localPart ? { local_part: localPart } : {}) })),
  );
  expect(status).toBe(201);
  return body as { id: string; address: string };
}

function mail(to: string, overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
  return {
    providerMessageId: `p-${Math.random().toString(36).slice(2)}`,
    from: { name: "Ada", address: "ada@example.net" },
    to: [to],
    subject: "Your code",
    text: "123456",
    html: null,
    headers: {},
    messageId: null,
    inReplyTo: null,
    attachments: [],
    raw: null,
    verdicts: null,
    ...overrides,
  };
}

async function ingest(item: NormalizedInboundMessage): Promise<void> {
  const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
  const result = await ingestInboundMessages(domain!, [item]);
  expect(result.accepted).toBe(1);
}

async function read(addressId: string, query = "", secret = fixture.secret): Promise<{ status: number; body: Page & Record<string, unknown> }> {
  const { status, body } = await call(messagesRoute(apiRequest(secret, `/v1/addresses/${addressId}/messages${query}`), routeContext(addressId)));
  return { status, body: body as Page & Record<string, unknown> };
}

async function reply(addressId: string, body: Record<string, unknown>, secret = fixture.secret) {
  return call(replyRoute(apiRequest(secret, `/v1/addresses/${addressId}/reply`, "POST", body), routeContext(addressId)));
}

async function sent(id: string) {
  const [row] = await db.select().from(messages).where(eq(messages.id, id));
  return row!;
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  resetDnsCheckCache();
  dmarc.clear();
  fixture = await seedFixture();
  await db.update(domains).set({ inboundEnabled: true }).where(eq(domains.id, fixture.domainId));
});
afterEach(async () => {
  delete process.env.REDIS_URL;
  await closeRedis();
});

describe("GET /v1/addresses/:id/messages", () => {
  it("lists only this address's mail, newest first, and pages with cursor and after", async () => {
    const address = await createAddress("agent");
    const other = await createAddress("other");
    for (const subject of ["one", "two", "three"]) await ingest(mail(address.address, { subject }));
    await ingest(mail(other.address, { subject: "not mine" }));

    const first = await read(address.id, "?limit=2");
    expect(first.status).toBe(200);
    expect(first.body.data.map((m) => m.subject)).toEqual(["three", "two"]);
    expect(first.body.data.every((m) => m.address_ids.includes(address.id))).toBe(true);

    const second = await read(address.id, `?limit=2&cursor=${first.body.next_cursor}`);
    expect(second.body.data.map((m) => m.subject)).toEqual(["one"]);
    expect(second.body.next_cursor).toBeNull();

    const oldest = second.body.data[0]!.id;
    const newer = await read(address.id, `?after=${oldest}`);
    expect(newer.body.data.map((m) => m.subject)).toEqual(["three", "two"]);
  });

  it("refuses an after id the organization doesn't have", async () => {
    const address = await createAddress();
    const { status, body } = await read(address.id, `?after=${newId("inbound")}`);
    expect(status).toBe(404);
    expect(errorOf(body).code).toBe("not_found");
  });

  it("is scoped to the key's organization and domains, and refuses a test key", async () => {
    const address = await createAddress();
    await ingest(mail(address.address));

    const elsewhere = await seedFixture();
    expect((await read(address.id, "", elsewhere.secret)).status).toBe(404);

    const otherDomain = await addDomainKey(fixture);
    const scoped = await read(address.id, "", otherDomain.secret);
    expect(scoped.status).toBe(403);
    expect(errorOf(scoped.body).code).toBe("key_not_scoped");

    const test = await createApiKey({ organizationId: fixture.organizationId, name: "test", mode: "test", domainIds: [] });
    expect((await read(address.id, "", test.secret)).status).toBe(403);
  });

  it("keeps reading after the address expires or is revoked", async () => {
    const address = await createAddress();
    await ingest(mail(address.address));
    await call(revokeRoute(apiRequest(fixture.secret, `/v1/addresses/${address.id}`, "DELETE"), routeContext(address.id)));
    expect((await read(address.id)).body.data).toHaveLength(1);
  });
});

describe("threads", () => {
  it("groups a References chain, a reply that names only References, and a reply to Pouch's own reply", async () => {
    const address = await createAddress();
    await ingest(mail(address.address, { subject: "a", messageId: "<a@example.net>", headers: { "message-id": "<a@example.net>" } }));
    await ingest(
      mail(address.address, {
        subject: "b",
        messageId: "<b@example.net>",
        inReplyTo: "<A@example.net>",
        headers: { "message-id": "<b@example.net>", "in-reply-to": "<A@example.net>" },
      }),
    );
    // In-Reply-To names nothing stored; References still reaches the chain.
    await ingest(
      mail(address.address, {
        subject: "c",
        messageId: "<c@example.net>",
        inReplyTo: "<unknown@example.org>",
        headers: { References: "<a@example.net>\r\n <b@example.net>" },
      }),
    );
    await ingest(mail(address.address, { subject: "unrelated", messageId: "<z@example.net>" }));

    const all = (await read(address.id)).body.data;
    const thread = all.find((m) => m.subject === "a")!.thread_id;
    expect(thread).toMatch(/^thr_/);
    expect(all.find((m) => m.subject === "unrelated")!.thread_id).not.toBe(thread);

    // Pouch's reply carries In-Reply-To <c>; the answer to it names only the reply's own id.
    const { status, body } = await reply(address.id, { message_id: all.find((m) => m.subject === "c")!.id, text: "Thanks" });
    expect(status).toBe(202);
    await db.update(messages).set({ providerMessageId: "0100-reply" }).where(eq(messages.id, body.id as string));
    await ingest(mail(address.address, { subject: "d", messageId: "<d@example.net>", inReplyTo: "<0100-reply@us-west-2.amazonses.com>" }));

    const threaded = (await read(address.id, `?thread=${thread}`)).body.data;
    expect(threaded.map((m) => m.subject)).toEqual(["d", "c", "b", "a"]);
  });

  it("never joins a thread in another organization", async () => {
    const address = await createAddress();
    await ingest(mail(address.address, { messageId: "<shared@example.net>" }));
    const [mine] = (await read(address.id)).body.data;

    const elsewhere = await seedFixture();
    await db.update(domains).set({ inboundEnabled: true }).where(eq(domains.id, elsewhere.domainId));
    const [theirDomain] = await db.select().from(domains).where(eq(domains.id, elsewhere.domainId));
    await ingestInboundMessages(theirDomain!, [mail("x@inbound.example.com", { inReplyTo: "<shared@example.net>" })]);
    const [theirs] = await db.execute<{ thread_id: string }>(
      sql`select thread_id from inbound_messages where organization_id = ${elsewhere.organizationId}`,
    );
    expect(theirs!.thread_id).not.toBe(mine!.thread_id);
  });
});

describe("POST /v1/addresses/:id/reply", () => {
  async function received(overrides: Partial<NormalizedInboundMessage> = {}) {
    const address = await createAddress("agent");
    await ingest(mail(address.address, overrides));
    const [message] = (await read(address.id)).body.data;
    return { address, message: message! };
  }

  it("sends from the address to the sender, threaded on the message and its references", async () => {
    const { address, message } = await received({
      subject: "Your code",
      messageId: "<c@example.net>",
      headers: { References: "<a@example.net> <b@example.net>" },
    });

    const { status, body } = await reply(address.id, { message_id: message.id, text: "Got it" });
    expect(status).toBe(202);
    const row = await sent(body.id as string);
    expect(row.fromAddress).toBe("agent@inbound.example.com");
    expect(row.domainId).toBe(fixture.domainId);
    expect(row.recipients).toEqual(["ada@example.net"]);
    expect(row.subject).toBe("Re: Your code");
    expect(row.envelope.headers).toEqual({ "In-Reply-To": "<c@example.net>", References: "<a@example.net> <b@example.net> <c@example.net>" });
  });

  it("goes to Reply-To when the message has one, and keeps a subject that already says Re:", async () => {
    const { address, message } = await received({ subject: "RE: hello", headers: { "reply-to": "Desk <desk@example.net>" } });
    const { body } = await reply(address.id, { message_id: message.id, text: "Hi" });
    const row = await sent(body.id as string);
    expect(row.recipients).toEqual(["desk@example.net"]);
    expect(row.subject).toBe("RE: hello");
    expect(row.envelope.headers).toEqual({});
  });

  it("refuses an expired or revoked address", async () => {
    const { address, message } = await received();
    await db.update(addresses).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(addresses.id, address.id));
    const expired = await reply(address.id, { message_id: message.id, text: "Hi" });
    expect(expired.status).toBe(422);
    expect(errorOf(expired.body)).toMatchObject({ code: "address_inactive", detail: { status: "expired" } });

    await db.update(addresses).set({ expiresAt: sql`now() + interval '1 hour'`, status: "revoked" }).where(eq(addresses.id, address.id));
    const revoked = await reply(address.id, { message_id: message.id, text: "Hi" });
    expect(errorOf(revoked.body)).toMatchObject({ code: "address_inactive", detail: { status: "revoked" } });
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("refuses a message that wasn't delivered to this address", async () => {
    const { message } = await received();
    const other = await createAddress("other");
    const { status, body } = await reply(other.id, { message_id: message.id, text: "Hi" });
    expect(status).toBe(404);
    expect(errorOf(body).code).toBe("not_found");
  });

  it("refuses to answer a sender that failed DMARC", async () => {
    const { address, message } = await received({ verdicts: { spam: "pass", virus: "pass", spf: "fail", dkim: "fail", dmarc: "fail" } });
    const { status, body } = await reply(address.id, { message_id: message.id, text: "Hi" });
    expect(status).toBe(422);
    expect(errorOf(body)).toMatchObject({ code: "reply_not_allowed", detail: { reason: "sender_unverified" } });
  });

  it("refuses a provider that can't send from the subdomain", async () => {
    const { address, message } = await received();
    await db.update(providers).set({ adapter: "mailpace" }).where(eq(providers.id, fixture.providerId));
    const { body } = await reply(address.id, { message_id: message.id, text: "Hi" });
    expect(errorOf(body)).toMatchObject({ code: "reply_not_allowed", detail: { reason: "provider_incapable" } });
  });

  it("refuses when DMARC asks for strict DKIM alignment, and sends under relaxed", async () => {
    const { address, message } = await received();
    dmarc.set("_dmarc.example.com", ["v=DMARC1; p=reject; adkim=s"]);
    const strict = await reply(address.id, { message_id: message.id, text: "Hi" });
    expect(errorOf(strict.body)).toMatchObject({ code: "reply_not_allowed", detail: { reason: "strict_alignment" } });

    resetDnsCheckCache();
    dmarc.set("_dmarc.inbound.example.com", ["v=DMARC1; p=reject; adkim=r"]);
    expect((await reply(address.id, { message_id: message.id, text: "Hi" })).status).toBe(202);
  });

  it("applies the send path's rules: suppression and domain scope", async () => {
    const { address, message } = await received();
    await addSuppression(fixture.organizationId, "ada@example.net");
    const suppressed = await reply(address.id, { message_id: message.id, text: "Hi" });
    expect(errorOf(suppressed.body).code).toBe("recipient_suppressed");

    const otherDomain = await addDomainKey(fixture);
    const scoped = await reply(address.id, { message_id: message.id, text: "Hi" }, otherDomain.secret);
    expect(errorOf(scoped.body).code).toBe("key_not_scoped");
  });

  it("is the only way to send from an address: POST /v1/emails doesn't know the inbound host", async () => {
    const address = await createAddress("agent");
    const { status, body } = await call(
      sendRoute(apiRequest(fixture.secret, "/v1/emails", "POST", { from: address.address, to: "ada@example.net", subject: "Hi", text: "Hi" })),
    );
    expect(status).toBe(422);
    expect(errorOf(body).code).toBe("domain_not_verified");
  });

  it("refuses an unverified domain", async () => {
    const { address, message } = await received();
    await db.update(domains).set({ status: "pending" }).where(eq(domains.id, fixture.domainId));
    const { body } = await reply(address.id, { message_id: message.id, text: "Hi" });
    expect(errorOf(body).code).toBe("domain_not_verified");
  });
});

describe("reply headers", () => {
  it("puts In-Reply-To and References on the wire", () => {
    const headers = replyHeaders({ messageId: "<c@example.net>", headers: { references: "<a@example.net> <b@example.net>" } });
    const mime = buildMime({
      from: { address: "agent@inbound.example.com", name: null },
      to: ["ada@example.net"],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: "Re: hi",
      html: null,
      text: "ok",
      headers,
      attachments: [],
      tags: [],
    } as unknown as Parameters<typeof buildMime>[0]);
    expect(mime).toContain("In-Reply-To: <c@example.net>\r\n");
    expect(mime).toContain("References: <a@example.net> <b@example.net> <c@example.net>\r\n");
  });

  it("carries at most 20 references, keeping the newest", () => {
    const chain = Array.from({ length: 30 }, (_, i) => `<r${i}@example.net>`).join(" ");
    const { References } = replyHeaders({ messageId: "<last@example.net>", headers: { References: chain } });
    const ids = References!.split(" ");
    expect(ids).toHaveLength(20);
    expect(ids.at(-1)).toBe("<last@example.net>");
    expect(ids[0]).toBe("<r11@example.net>");
  });
});

for (const live of [true, false]) {
  describe(`waiting for mail ${live ? "with live updates" : "by polling"}`, () => {
    beforeEach(async () => {
      if (live) process.env.REDIS_URL = REDIS_URL;
      await closeRedis();
    });

    it("returns as soon as a message arrives", async () => {
      const address = await createAddress();
      const started = Date.now();
      const naps = vi.spyOn(globalThis, "setTimeout");
      const pending = read(address.id, "?wait=20");
      try {
        await vi.waitFor(() => expect(naps.mock.calls.some(([, ms]) => ms === (live ? 5000 : 1000))).toBe(true), { interval: 5 });
      } finally {
        naps.mockRestore();
      }
      await ingest(mail(address.address, { subject: "code 4821" }));
      const { status, body } = await pending;
      expect(status).toBe(200);
      expect(body.data.map((m) => m.subject)).toEqual(["code 4821"]);
      expect(Date.now() - started).toBeLessThan(live ? 3000 : 4000);
    });

    it("answers at once when mail is already there, and waits past it with after", async () => {
      const address = await createAddress();
      await ingest(mail(address.address, { subject: "first" }));
      const [first] = (await read(address.id, "?wait=20")).body.data;
      expect(first!.subject).toBe("first");

      const started = Date.now();
      const { status, body } = await read(address.id, `?wait=1&after=${first!.id}`);
      expect(status).toBe(200);
      expect(body).toEqual({ data: [], next_cursor: null });
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    });
  });
}

describe("waiting for mail, limits", () => {
  beforeEach(async () => {
    process.env.REDIS_URL = REDIS_URL;
    await closeRedis();
  });

  it("holds one of the key's stream slots, and refuses past the ceiling", async () => {
    const address = await createAddress();
    const slots = [];
    for (let i = 0; i < maxConcurrentStreams(); i += 1) {
      const outcome = await acquireStreamSlot(fixture.key.id, maxConcurrentStreams());
      if (outcome.ok) slots.push(outcome.slot);
    }
    const { status, body } = await read(address.id, "?wait=5");
    expect(status).toBe(429);
    expect(errorOf(body).code).toBe("stream_limit_exceeded");
    await Promise.all(slots.map((slot) => slot.release()));
  });

  it("refuses wait with cursor", async () => {
    const address = await createAddress();
    const { status } = await read(address.id, `?wait=5&cursor=${newId("inbound")}`);
    expect(status).toBe(422);
  });
});
