import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { addresses, domains, inboundMessages, organizations, webhookDeliveries } from "@/lib/db/schema";
import { ingestInboundMessages, receiveInbound } from "@/lib/inbound/ingest";
import { createEndpoint, upsertDomainEndpoint } from "@/lib/webhooks/endpoints";
import { claimDeliveries } from "@/lib/webhooks/queue";
import { sign } from "@/lib/webhooks/sign";
import { createApiKey } from "@/lib/api/key-lifecycle";
import type { NormalizedInboundMessage } from "@/lib/providers/adapters/types";
import { GET as listRoute, POST as createRoute } from "@/app/api/v1/addresses/route";
import { DELETE as revokeRoute, GET as readRoute, PATCH as patchRoute } from "@/app/api/v1/addresses/[id]/route";
import { PATCH as patchAdminOrganization } from "@/app/api/v1/admin/organizations/[id]/route";
import { GET as organizationRoute } from "@/app/api/v1/organization/route";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { adminActor } from "@/lib/activity/record";
import { setSetting } from "@/lib/settings/values";
import { deliverWebhook } from "@/worker/webhooks";
import { AddressExpiryLoop } from "@/worker/address-expiry";
import { addDomainKey, apiRequest, resetDatabase, routeContext, seedFixture, seedUser, type Fixture } from "./fixtures";

vi.mock("node:dns/promises", () => ({ lookup: () => Promise.resolve([{ address: "203.0.113.9", family: 4 }]) }));

const posted = vi.hoisted(() => [] as { body: string; headers: Record<string, string> }[]);
vi.mock("@/lib/webhooks/deliver", () => ({
  postSigned: (_target: unknown, body: string, headers: Record<string, string>) => {
    posted.push({ body, headers });
    return Promise.resolve({ statusCode: 200, error: null, durationMs: 1 });
  },
}));

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

let fixture: Fixture;

interface AddressBody {
  id: string;
  address: string;
  local_part: string;
  status: string;
  expires_at: string;
  key_id: string | null;
  counts: { received: number; dropped_expired: number; dropped_over_limit: number; dropped_virus: number };
}

async function call(response: Promise<Response>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function errorCode(body: Record<string, unknown>): string | undefined {
  return (body.error as { code?: string } | undefined)?.code;
}

async function create(body: Record<string, unknown>, secret = fixture.secret) {
  return call(createRoute(apiRequest(secret, "/v1/addresses", "POST", { domain_id: fixture.domainId, expires_in: 3600, ...body })));
}

async function created(body: Record<string, unknown> = {}): Promise<AddressBody> {
  const { status, body: address } = await create(body);
  expect(status).toBe(201);
  return address as unknown as AddressBody;
}

async function addressRow(id: string) {
  const [row] = await db.select().from(addresses).where(eq(addresses.id, id));
  return row!;
}

async function enableInbound() {
  await db
    .update(domains)
    .set({ inboundEnabled: true, inboundProviderSettings: { webhookPublicKey: publicKey } })
    .where(eq(domains.id, fixture.domainId));
  return upsertDomainEndpoint(fixture.organizationId, fixture.domainId, "https://receiver.example.net/domain");
}

/** A Mailpace inbound callback, signed as Mailpace signs it. */
function mailpace(to: string, id: number | string = 501) {
  const rawBody = JSON.stringify({ id, from: "Ada Lovelace <ada@example.net>", to, subject: "Your code", text: "123456", headers: {}, messageId: `<m-${id}@example.net>` });
  return { rawBody, headers: { "x-mailpace-signature": ed25519Sign(null, Buffer.from(rawBody), keys.privateKey).toString("base64") } };
}

async function receive(to: string, id: number | string = 501) {
  const outcome = await receiveInbound("mailpace", fixture.domainId, mailpace(to, id));
  expect(outcome.verified).toBe(true);
  return outcome.result!;
}

function normalized(to: string, overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
  return {
    providerMessageId: `p-${Math.random().toString(36).slice(2)}`,
    from: { name: null, address: "ada@example.net" },
    to: [to],
    subject: "Hello",
    text: "body",
    html: "<p>body</p>",
    headers: {},
    messageId: null,
    inReplyTo: null,
    attachments: [],
    raw: null,
    verdicts: null,
    ...overrides,
  };
}

async function ingest(item: NormalizedInboundMessage) {
  const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
  return ingestInboundMessages(domain!, [item]);
}

async function deliveries(eventType: "address.received" | "inbound.received") {
  return db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.organizationId, fixture.organizationId), eq(webhookDeliveries.eventType, eventType)));
}

async function subscribe(apiKeyId = fixture.key.id) {
  return createEndpoint({ organizationId: fixture.organizationId, apiKeyId, url: "https://agent.example.net/hook", events: ["address.received"] });
}

async function expire(id: string) {
  await db.update(addresses).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(addresses.id, id));
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  posted.length = 0;
  fixture = await seedFixture({ providerAdapter: "mailpace" });
  await enableInbound();
});

describe("POST /v1/addresses", () => {
  it("creates a random address on the domain's inbound host, owned by the creating key", async () => {
    const address = await created({ label: "signup test" });

    expect(address.id).toMatch(/^adr_/);
    expect(address.local_part).toMatch(/^[a-z0-9]{16}$/);
    expect(address.address).toBe(`${address.local_part}@inbound.example.com`);
    expect(address).toMatchObject({ status: "active", key_id: fixture.key.id, label: "signup test" });
    expect(address.counts).toEqual({ received: 0, received_today: 0, dropped_expired: 0, dropped_over_limit: 0, dropped_virus: 0, forwarded: 0 });
  });

  it("takes a chosen local part, lowercased, and an absolute expiry", async () => {
    const at = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const address = await created({ local_part: "Signup.Bot", expires_in: undefined, expires_at: at });

    expect(address.address).toBe("signup.bot@inbound.example.com");
    expect(address.expires_at).toBe(at);
  });

  it("refuses a local part already taken, even by a revoked address", async () => {
    const first = await created({ local_part: "taken" });
    await call(revokeRoute(apiRequest(fixture.secret, `/v1/addresses/${first.id}`, "DELETE"), routeContext(first.id)));

    const { status, body } = await create({ local_part: "taken" });
    expect(status).toBe(422);
    expect(errorCode(body)).toBe("address_exists");
  });

  it("needs exactly one expiry, inside the window, and refuses postmaster", async () => {
    expect(errorCode((await create({ expires_in: undefined })).body)).toBe("validation_failed");
    expect(errorCode((await create({ expires_at: new Date(Date.now() + 3600_000).toISOString() })).body)).toBe("validation_failed");
    expect(errorCode((await create({ expires_in: 10 })).body)).toBe("validation_failed");
    expect(errorCode((await create({ expires_in: undefined, expires_at: new Date(Date.now() - 1000).toISOString() })).body)).toBe("validation_failed");
    expect(errorCode((await create({ local_part: "postmaster" })).body)).toBe("validation_failed");
  });

  it("refuses a domain that doesn't accept mail", async () => {
    await db.update(domains).set({ inboundEnabled: false }).where(eq(domains.id, fixture.domainId));
    const { status, body } = await create({});
    expect(status).toBe(422);
    expect(errorCode(body)).toBe("inbound_disabled");
  });

  it("stops at the organization's active limit, counting neither expired nor revoked addresses", async () => {
    await db.update(organizations).set({ addressLimit: 2 }).where(eq(organizations.id, fixture.organizationId));
    const first = await created();
    const second = await created();

    const refused = await create({});
    expect(refused.status).toBe(422);
    expect(errorCode(refused.body)).toBe("address_limit_reached");
    expect((refused.body.error as { detail: unknown }).detail).toEqual({ limit: 2 });

    await expire(first.id);
    await call(revokeRoute(apiRequest(fixture.secret, `/v1/addresses/${second.id}`, "DELETE"), routeContext(second.id)));
    const third = await created();
    await created();

    // Bringing the expired one back would make three.
    const revived = await call(patchRoute(apiRequest(fixture.secret, `/v1/addresses/${first.id}`, "PATCH", { expires_in: 3600 }), routeContext(first.id)));
    expect(revived.status).toBe(422);
    expect(errorCode(revived.body)).toBe("address_limit_reached");

    const unscoped = await createApiKey({ organizationId: fixture.organizationId, name: "everything", mode: "live", domainIds: [] });
    const counted = await call(organizationRoute(apiRequest(unscoped.secret, "/v1/organization?include=address_counts")));
    expect(counted.body.address_counts).toEqual({ active: 2, expired: 1, revoked: 1 });

    await call(revokeRoute(apiRequest(fixture.secret, `/v1/addresses/${third.id}`, "DELETE"), routeContext(third.id)));
    const again = await call(patchRoute(apiRequest(fixture.secret, `/v1/addresses/${first.id}`, "PATCH", { expires_in: 3600 }), routeContext(first.id)));
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("active");

    const plain = await call(organizationRoute(apiRequest(unscoped.secret, "/v1/organization")));
    expect(plain.status).toBe(200);
    expect(plain.body).not.toHaveProperty("address_counts");
  });

  it("follows the install's default while the organization has none of its own", async () => {
    await setSetting("address_limit_default", 1, adminActor("usr_admin", "Admin"));
    await created();
    const refused = await create({});
    expect(errorCode(refused.body)).toBe("address_limit_reached");
    expect((refused.body.error as { detail: unknown }).detail).toEqual({ limit: 1 });

    const unscoped = await createApiKey({ organizationId: fixture.organizationId, name: "everything", mode: "live", domainIds: [] });
    const read = await call(organizationRoute(apiRequest(unscoped.secret, "/v1/organization")));
    expect(read.body).toMatchObject({ address_limit: 1, address_daily_message_limit: 100 });
  });

  it("is set by an admin on the organization", async () => {
    const admin = await seedUser({ admin: true });
    const minted = await createApiKey({ organizationId: null, name: "admin", mode: "live", domainIds: [], scope: "admin", createdBy: admin.userId });
    const response = await call(
      patchAdminOrganization(
        apiRequest(minted.secret, `/v1/admin/organizations/${fixture.organizationId}`, "PATCH", { address_limit: 1, address_daily_message_limit: 5 }),
        routeContext(fixture.organizationId),
      ),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ address_limit: 1, address_daily_message_limit: 5 });

    await created();
    expect(errorCode((await create({})).body)).toBe("address_limit_reached");
  });
});

describe("key scope", () => {
  it("keeps a domain-scoped key to its own domain's addresses", async () => {
    const mine = await created();
    const other = await addDomainKey(fixture, "second.example.com");
    await db.update(domains).set({ inboundEnabled: true }).where(eq(domains.id, other.domainId));

    const refused = await create({ domain_id: other.domainId });
    expect(refused.status).toBe(403);
    expect(errorCode(refused.body)).toBe("key_not_scoped");

    const theirs = await create({ domain_id: other.domainId }, other.secret);
    expect(theirs.status).toBe(201);
    const theirId = theirs.body.id as string;

    expect((await call(readRoute(apiRequest(fixture.secret, `/v1/addresses/${theirId}`), routeContext(theirId)))).status).toBe(403);
    expect((await call(revokeRoute(apiRequest(fixture.secret, `/v1/addresses/${theirId}`, "DELETE"), routeContext(theirId)))).status).toBe(403);
    const listed = await call(listRoute(apiRequest(fixture.secret, "/v1/addresses")));
    expect((listed.body.data as AddressBody[]).map((a) => a.id)).toEqual([mine.id]);
  });

  it("never reaches another organization's addresses", async () => {
    const mine = await created();
    const stranger = await seedFixture({ providerAdapter: "mailpace", scopeToDomain: false });

    expect((await call(readRoute(apiRequest(stranger.secret, `/v1/addresses/${mine.id}`), routeContext(mine.id)))).status).toBe(404);
    expect((await call(patchRoute(apiRequest(stranger.secret, `/v1/addresses/${mine.id}`, "PATCH", { label: "x" }), routeContext(mine.id)))).status).toBe(404);
    expect((await call(revokeRoute(apiRequest(stranger.secret, `/v1/addresses/${mine.id}`, "DELETE"), routeContext(mine.id)))).status).toBe(404);
    const listed = await call(listRoute(apiRequest(stranger.secret, "/v1/addresses")));
    expect(listed.body.data).toEqual([]);
    const createdThere = await create({ domain_id: fixture.domainId }, stranger.secret);
    expect(createdThere.status).toBe(404);
  });

  it("refuses a test-mode key", async () => {
    const test = await seedFixture({ providerAdapter: "mailpace", keyMode: "test" });
    const { status, body } = await call(listRoute(apiRequest(test.secret, "/v1/addresses")));
    expect(status).toBe(403);
    expect(errorCode(body)).toBe("key_not_scoped");
  });
});

describe("reading, extending and revoking", () => {
  it("pages newest first and filters by status", async () => {
    const a = await created();
    const b = await created();
    const c = await created();
    await expire(a.id);

    const first = await call(listRoute(apiRequest(fixture.secret, "/v1/addresses?limit=2")));
    expect((first.body.data as AddressBody[]).map((x) => x.id)).toEqual([c.id, b.id]);
    const second = await call(listRoute(apiRequest(fixture.secret, `/v1/addresses?limit=2&cursor=${first.body.next_cursor as string}`)));
    expect((second.body.data as AddressBody[]).map((x) => x.id)).toEqual([a.id]);
    expect(second.body.next_cursor).toBeNull();

    const expired = await call(listRoute(apiRequest(fixture.secret, "/v1/addresses?status=expired")));
    expect((expired.body.data as AddressBody[]).map((x) => x.id)).toEqual([a.id]);
    const active = await call(listRoute(apiRequest(fixture.secret, "/v1/addresses?status=active")));
    expect((active.body.data as AddressBody[]).map((x) => x.id)).toEqual([c.id, b.id]);
  });

  it("extends an expired address back to active, and refuses to edit a revoked one", async () => {
    const address = await created();
    await expire(address.id);
    expect((await call(readRoute(apiRequest(fixture.secret, `/v1/addresses/${address.id}`), routeContext(address.id)))).body.status).toBe("expired");

    const extended = await call(patchRoute(apiRequest(fixture.secret, `/v1/addresses/${address.id}`, "PATCH", { expires_in: 7200, label: "longer" }), routeContext(address.id)));
    expect(extended.body).toMatchObject({ status: "active", label: "longer" });
    expect(new Date(extended.body.expires_at as string).getTime()).toBeGreaterThan(Date.now() + 7000_000);

    const revoked = await call(revokeRoute(apiRequest(fixture.secret, `/v1/addresses/${address.id}`, "DELETE"), routeContext(address.id)));
    expect(revoked.body).toMatchObject({ status: "revoked" });
    expect(revoked.body.revoked_at).not.toBeNull();

    const edited = await call(patchRoute(apiRequest(fixture.secret, `/v1/addresses/${address.id}`, "PATCH", { expires_in: 3600 }), routeContext(address.id)));
    expect(edited.status).toBe(422);
    expect(errorCode(edited.body)).toBe("validation_failed");
  });
});

describe("mail to an address", () => {
  it("stores it, counts it and emits a signed address.received to the creating key's endpoint, not the domain's", async () => {
    const { secret } = await subscribe();
    const address = await created();

    expect(await receive(`Agent <${address.address.toUpperCase()}>`)).toEqual({ accepted: 1, duplicates: 0 });

    const [message] = await db.select().from(inboundMessages).where(eq(inboundMessages.domainId, fixture.domainId));
    expect(message?.addressIds).toEqual([address.id]);
    expect((await addressRow(address.id)).receivedCount).toBe(1);
    expect(await deliveries("inbound.received")).toEqual([]);

    const claimed = await claimDeliveries("worker-test", 10);
    expect(claimed).toHaveLength(1);
    await deliverWebhook(claimed[0]!);

    expect(posted).toHaveLength(1);
    const { body, headers } = posted[0]!;
    expect(headers["X-Webhook-Event"]).toBe("address.received");
    expect(headers["X-Signature"]).toBe(sign(secret, Number(headers["X-Timestamp"]), body));
    const payload = JSON.parse(body) as { type: string; data: { id: string; text: string; address: AddressBody; flags: string[]; address_ids: string[] } };
    expect(payload.type).toBe("address.received");
    expect(payload.data).toMatchObject({ id: message!.id, text: "123456", flags: [], address_ids: [address.id] });
    expect(payload.data.address).toMatchObject({ id: address.id, address: address.address });
    expect(payload.data.address.counts.received).toBe(1);
  });

  it("leaves mail for anyone else on the host to the domain's webhook", async () => {
    await subscribe();
    await created();
    await receive("support@inbound.example.com");

    expect(await deliveries("inbound.received")).toHaveLength(1);
    expect(await deliveries("address.received")).toEqual([]);
  });

  it("reaches no endpoint of another key, or one not subscribed to address.received", async () => {
    const other = await createApiKey({ organizationId: fixture.organizationId, name: "other", mode: "live", domainIds: [] });
    await subscribe(other.key.id);
    await createEndpoint({ organizationId: fixture.organizationId, apiKeyId: fixture.key.id, url: "https://agent.example.net/email", events: ["email.delivered"] });
    const address = await created();

    await receive(address.address);
    expect((await addressRow(address.id)).receivedCount).toBe(1);
    expect(await deliveries("address.received")).toEqual([]);
  });

  it("counts a provider's retry once", async () => {
    await subscribe();
    const address = await created();
    await receive(address.address, 900);
    expect(await receive(address.address, 900)).toEqual({ accepted: 0, duplicates: 1 });

    expect((await addressRow(address.id)).receivedCount).toBe(1);
    expect(await deliveries("address.received")).toHaveLength(1);
  });
});

describe("drop and count", () => {
  it("drops mail after expiry silently: nothing stored, nothing delivered, counted on the address", async () => {
    await subscribe();
    const address = await created();
    await expire(address.id);

    expect(await receive(address.address)).toEqual({ accepted: 1, duplicates: 0 });

    expect(await db.select().from(inboundMessages)).toEqual([]);
    expect(await deliveries("address.received")).toEqual([]);
    expect(await deliveries("inbound.received")).toEqual([]);
    expect(await addressRow(address.id)).toMatchObject({ receivedCount: 0, droppedExpiredCount: 1 });
  });

  it("drops mail after revocation the same way", async () => {
    await subscribe();
    const address = await created();
    await call(revokeRoute(apiRequest(fixture.secret, `/v1/addresses/${address.id}`, "DELETE"), routeContext(address.id)));

    await receive(address.address);
    expect(await db.select().from(inboundMessages)).toEqual([]);
    expect(await deliveries("inbound.received")).toEqual([]);
    expect(await addressRow(address.id)).toMatchObject({ droppedExpiredCount: 1 });
  });

  it("drops past the daily limit and the message cap, counted apart from expiry", async () => {
    await subscribe();
    await db.update(organizations).set({ addressDailyMessageLimit: 2 }).where(eq(organizations.id, fixture.organizationId));
    const daily = await created();
    const capped = await created({ message_cap: 1 });

    await receive(daily.address, 1);
    await receive(daily.address, 2);
    await receive(daily.address, 3);
    await receive(capped.address, 4);
    await receive(capped.address, 5);

    expect(await addressRow(daily.id)).toMatchObject({ receivedCount: 2, droppedOverLimitCount: 1, droppedExpiredCount: 0 });
    const read = await call(readRoute(apiRequest(fixture.secret, `/v1/addresses/${daily.id}`), routeContext(daily.id)));
    expect(read.body.counts).toMatchObject({ received: 2, received_today: 2, dropped_over_limit: 1 });
    expect(await addressRow(capped.id)).toMatchObject({ receivedCount: 1, droppedOverLimitCount: 1, droppedExpiredCount: 0 });
    expect(await deliveries("address.received")).toHaveLength(3);
    expect(await db.select().from(inboundMessages)).toHaveLength(3);
  });

  it("drops past the install's daily default while the organization has none of its own", async () => {
    await subscribe();
    await setSetting("address_daily_message_limit_default", 1, adminActor("usr_admin", "Admin"));
    const address = await created();

    await receive(address.address, 1);
    await receive(address.address, 2);
    expect(await addressRow(address.id)).toMatchObject({ receivedCount: 1, droppedOverLimitCount: 1 });
  });

  it("starts a new day's count on a new UTC day", async () => {
    await db.update(organizations).set({ addressDailyMessageLimit: 1 }).where(eq(organizations.id, fixture.organizationId));
    const address = await created();
    await db.update(addresses).set({ receivedToday: 1, receivedDay: "2020-01-01" }).where(eq(addresses.id, address.id));
    const stale = await call(readRoute(apiRequest(fixture.secret, `/v1/addresses/${address.id}`), routeContext(address.id)));
    expect((stale.body.counts as { received_today: number }).received_today).toBe(0);

    await receive(address.address);
    expect(await addressRow(address.id)).toMatchObject({ receivedCount: 1, receivedToday: 1, droppedOverLimitCount: 0 });
  });

  it("still delivers to the domain's webhook when the message also names someone who isn't an address", async () => {
    const address = await created();
    await expire(address.id);
    await receive(`${address.address}, support@inbound.example.com`);

    expect(await deliveries("inbound.received")).toHaveLength(1);
    const [message] = await db.select().from(inboundMessages);
    expect(message?.addressIds).toEqual([]);
    expect(await addressRow(address.id)).toMatchObject({ droppedExpiredCount: 1 });
  });
});

describe("verdicts", () => {
  it("never delivers a virus, and keeps nothing of it", async () => {
    await subscribe();
    const address = await created();
    await ingest(normalized(address.address, { verdicts: { spam: "pass", virus: "fail", spf: "pass", dkim: "pass", dmarc: "pass" } }));

    expect(await db.select().from(inboundMessages)).toEqual([]);
    expect(await deliveries("address.received")).toEqual([]);
    expect(await addressRow(address.id)).toMatchObject({ receivedCount: 0, droppedVirusCount: 1 });
  });

  it("delivers spam and DMARC failures, flagged", async () => {
    await subscribe();
    const address = await created();
    await ingest(normalized(address.address, { verdicts: { spam: "fail", virus: "pass", spf: "fail", dkim: "fail", dmarc: "fail" } }));

    const [delivery] = await deliveries("address.received");
    const data = (delivery?.payload as { data: { flags: string[]; verdicts: { spam: string } } }).data;
    expect(data.flags).toEqual(["spam", "dmarc"]);
    expect(data.verdicts.spam).toBe("fail");
    expect((await addressRow(address.id)).receivedCount).toBe(1);
  });
});

describe("the expiry sweep", () => {
  it("marks addresses past their expiry expired and leaves the rest", async () => {
    const stale = await created();
    const fresh = await created();
    await expire(stale.id);

    const loop = new AddressExpiryLoop({ intervalMs: 60_000, batchSize: 1 });
    expect(await loop.tick()).toEqual({ expired: 1 });

    expect((await addressRow(stale.id)).status).toBe("expired");
    expect((await addressRow(fresh.id)).status).toBe("active");
  });
});
