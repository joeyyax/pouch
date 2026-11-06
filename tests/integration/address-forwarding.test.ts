import { and, arrayContains, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { addressForwardTargets, addressForwards, addresses, apiKeys, domains, messages, providers, users, webhookDeliveries } from "@/lib/db/schema";
import { ingestInboundMessages } from "@/lib/inbound/ingest";
import { pendingForwards, sendForward } from "@/lib/addresses/forward-send";
import { forwardStopUrl } from "@/lib/addresses/forward-targets";
import { createApiKey } from "@/lib/api/key-lifecycle";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { resetDnsCheckCache } from "@/lib/domains/dns-check";
import { applyEvent } from "@/lib/messages/events";
import { readBody } from "@/lib/storage/bodies";
import { closeRedis } from "@/lib/redis";
import { createEndpoint } from "@/lib/webhooks/endpoints";
import type { NormalizedInboundMessage } from "@/lib/providers/adapters/types";
import { POST as createAddressRoute } from "@/app/api/v1/addresses/route";
import { DELETE as revokeRoute, GET as readAddressRoute } from "@/app/api/v1/addresses/[id]/route";
import { GET as listTargetsRoute, POST as addTargetRoute } from "@/app/api/v1/addresses/[id]/forward_targets/route";
import { DELETE as removeTargetRoute, GET as readTargetRoute } from "@/app/api/v1/addresses/[id]/forward_targets/[targetId]/route";
import { POST as resendRoute } from "@/app/api/v1/addresses/[id]/forward_targets/[targetId]/resend_confirmation/route";
import { GET as confirmPage, POST as confirmPost } from "@/app/forward/confirm/[token]/route";
import { GET as stopPage, POST as stopPost } from "@/app/forward/stop/[token]/route";
import { DEFAULT_SYSTEM_FROM_ADDRESS } from "@/lib/mail/system";
import { addSuppression, apiRequest, disableSystemMail, eventSource, resetDatabase, routeContext, seedFixture, seedSystemOrganization, type Fixture } from "./fixtures";

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

vi.mock("@/lib/webhooks/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webhooks/ssrf")>();
  return { ...actual, resolvePublicTarget: async (url: string) => ({ url, address: "203.0.113.10", family: 4 }) };
});

const MAILBOX = "me@example.net";

let fixture: Fixture;

interface Target {
  id: string;
  email: string;
  status: string;
  disabled_reason: string | null;
  forwarded_count: number;
  confirmation_expires_at: string | null;
  last_failure: { code: string } | null;
}

async function call(response: Promise<Response>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function codeOf(body: Record<string, unknown>): string | undefined {
  return (body.error as { code?: string } | undefined)?.code;
}

function targetContext(id: string, targetId: string) {
  return { params: Promise.resolve({ id, targetId }) };
}

function tokenContext(token: string) {
  return { params: Promise.resolve({ token }) };
}

async function createAddress(options: { localPart?: string; messageCap?: number; secret?: string } = {}): Promise<{ id: string; address: string }> {
  const { status, body } = await call(
    createAddressRoute(
      apiRequest(options.secret ?? fixture.secret, "/v1/addresses", "POST", {
        domain_id: fixture.domainId,
        expires_in: 3600,
        ...(options.localPart ? { local_part: options.localPart } : {}),
        ...(options.messageCap ? { message_cap: options.messageCap } : {}),
      }),
    ),
  );
  expect(status).toBe(201);
  return body as { id: string; address: string };
}

async function addTarget(addressId: string, email = MAILBOX, secret = fixture.secret) {
  return call(addTargetRoute(apiRequest(secret, `/v1/addresses/${addressId}/forward_targets`, "POST", { email }), routeContext(addressId)));
}

/** The confirmation link's token, read out of the system mail Pouch queued to the mailbox. */
async function confirmationToken(email = MAILBOX): Promise<string> {
  const sent = await db
    .select()
    .from(messages)
    .where(and(arrayContains(messages.tags, ["forward-confirmation"]), arrayContains(messages.recipients, [email])))
    .orderBy(messages.createdAt);
  const last = sent.at(-1)!;
  const body = await readBody(Buffer.from(last.bodyKey!, "base64"), last.storageKey!);
  const match = /\/forward\/confirm\/([A-Za-z0-9_-]+)/.exec(body.text ?? "");
  expect(match).not.toBeNull();
  expect(body.html).toContain(`/forward/confirm/${match![1]}`);
  return match![1]!;
}

async function confirmedTarget(addressId: string, email = MAILBOX): Promise<Target> {
  const { status, body } = await addTarget(addressId, email);
  expect(status).toBe(201);
  const response = await confirmPost(new Request("http://localhost/forward/confirm/x", { method: "POST" }), tokenContext(await confirmationToken(email)));
  expect(response.status).toBe(200);
  return body as unknown as Target;
}

function mail(to: string, overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
  return {
    providerMessageId: `p-${Math.random().toString(36).slice(2)}`,
    from: { name: "Ada Lovelace", address: "ada@example.net" },
    to: [to],
    subject: "Invoice for September",
    text: "See attached.",
    html: null,
    headers: { References: "<root@example.net>" },
    messageId: "<inv-1@example.net>",
    inReplyTo: "<root@example.net>",
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

/** Runs what the worker's forward loop runs, once. */
async function drain(): Promise<void> {
  for (const id of await pendingForwards(50)) await sendForward(id);
}

async function forwardsSent() {
  return db.select().from(messages).where(arrayContains(messages.tags, ["forward"]));
}

async function readTarget(addressId: string, targetId: string): Promise<Target> {
  const { body } = await call(readTargetRoute(apiRequest(fixture.secret, `/v1/addresses/${addressId}/forward_targets/${targetId}`), targetContext(addressId, targetId)));
  return body as unknown as Target;
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  resetDnsCheckCache();
  dmarc.clear();
  await seedSystemOrganization();
  fixture = await seedFixture();
  await db.update(domains).set({ inboundEnabled: true }).where(eq(domains.id, fixture.domainId));
});
afterEach(async () => {
  await closeRedis();
});

describe("confirming a forward target", () => {
  it("mails a link, shows the question on GET without confirming, and confirms on POST", async () => {
    const address = await createAddress({ localPart: "intake" });
    const { status, body } = await addTarget(address.id);
    expect(status).toBe(201);
    expect(body).toMatchObject({ email: MAILBOX, status: "pending", address_id: address.id, forwarded_count: 0, disabled_reason: null });
    expect(body.id).toMatch(/^fwt_/);

    const [confirmation] = await db.select().from(messages).where(arrayContains(messages.tags, ["forward-confirmation"]));
    expect(confirmation).toMatchObject({ fromAddress: DEFAULT_SYSTEM_FROM_ADDRESS, recipients: [MAILBOX] });
    const token = await confirmationToken();

    const page = await confirmPage(new Request("http://localhost"), tokenContext(token));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`Test wants to forward mail sent to <strong>${address.address}</strong> to <strong>${MAILBOX}</strong>`);
    const sentBody = await readBody(Buffer.from(confirmation!.bodyKey!, "base64"), confirmation!.storageKey!);
    expect(sentBody.text).toContain(`Test wants mail sent to ${address.address}`);
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect((await readTarget(address.id, body.id as string)).status).toBe("pending");

    const confirmed = await confirmPost(new Request("http://localhost", { method: "POST" }), tokenContext(token));
    expect(confirmed.status).toBe(200);
    expect(await readTarget(address.id, body.id as string)).toMatchObject({ status: "confirmed", confirmation_expires_at: null });

    // A used link says it's already on, and confirms nothing new.
    const again = await confirmPost(new Request("http://localhost", { method: "POST" }), tokenContext(token));
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Forwarding is already on");
  });

  it("names the person whose key made the address on both the email and the page", async () => {
    const userId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, organizationId: fixture.organizationId, name: "Ada Lovelace", email: "ada@example.com" });
    await db.update(apiKeys).set({ createdBy: userId }).where(eq(apiKeys.id, fixture.key.id));
    const address = await createAddress();
    await addTarget(address.id);

    const [sent] = await db.select().from(messages).where(arrayContains(messages.tags, ["forward-confirmation"]));
    const mail = await readBody(Buffer.from(sent!.bodyKey!, "base64"), sent!.storageKey!);
    expect(mail.text).toContain("Ada Lovelace wants mail sent to");
    const page = await confirmPage(new Request("http://localhost"), tokenContext(await confirmationToken()));
    expect(await page.text()).toContain("Ada Lovelace wants to forward mail sent to");
  });

  it("keeps no target when the confirmation can't be mailed", async () => {
    const address = await createAddress();
    await disableSystemMail();
    const { status, body } = await addTarget(address.id);
    expect(status).toBe(503);
    expect(codeOf(body)).toBe("provider_unavailable");
    expect(await db.select().from(addressForwardTargets)).toEqual([]);
  });

  it("refuses a forged token and an expired one", async () => {
    const address = await createAddress();
    const { body } = await addTarget(address.id);
    const token = await confirmationToken();

    const forged = `${token.slice(0, -2)}xx`;
    expect((await confirmPage(new Request("http://localhost"), tokenContext(forged))).status).toBe(404);
    expect((await confirmPost(new Request("http://localhost", { method: "POST" }), tokenContext(forged))).status).toBe(404);

    await db.update(addressForwardTargets).set({ tokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(addressForwardTargets.id, body.id as string));
    expect((await confirmPage(new Request("http://localhost"), tokenContext(token))).status).toBe(404);
    expect((await confirmPost(new Request("http://localhost", { method: "POST" }), tokenContext(token))).status).toBe(404);
    expect((await readTarget(address.id, body.id as string)).status).toBe("pending");
  });

  it("resends a new link that replaces the old one, and only while pending", async () => {
    const address = await createAddress();
    const { body } = await addTarget(address.id);
    const first = await confirmationToken();

    const resent = await call(resendRoute(apiRequest(fixture.secret, "/x", "POST"), targetContext(address.id, body.id as string)));
    expect(resent.status).toBe(200);
    const second = await confirmationToken();
    expect(second).not.toBe(first);
    expect((await confirmPost(new Request("http://localhost", { method: "POST" }), tokenContext(first))).status).toBe(404);
    expect((await confirmPost(new Request("http://localhost", { method: "POST" }), tokenContext(second))).status).toBe(200);

    const again = await call(resendRoute(apiRequest(fixture.secret, "/x", "POST"), targetContext(address.id, body.id as string)));
    expect(again.status).toBe(422);
    expect(codeOf(again.body)).toBe("forward_target_not_pending");
  });

  it("won't confirm for an address that was revoked after the link went out", async () => {
    const address = await createAddress();
    await addTarget(address.id);
    const token = await confirmationToken();
    await revokeRoute(apiRequest(fixture.secret, `/v1/addresses/${address.id}`, "DELETE"), routeContext(address.id));
    expect((await confirmPost(new Request("http://localhost", { method: "POST" }), tokenContext(token))).status).toBe(404);
  });
});

describe("adding a forward target", () => {
  it("caps targets per address and refuses a duplicate", async () => {
    const address = await createAddress();
    for (let n = 0; n < 5; n += 1) expect((await addTarget(address.id, `box${n}@example.net`)).status).toBe(201);
    const sixth = await addTarget(address.id, "box6@example.net");
    expect(sixth.status).toBe(422);
    expect(codeOf(sixth.body)).toBe("forward_target_limit_reached");

    const other = await createAddress();
    await addTarget(other.id, "Same@Example.NET");
    const duplicate = await addTarget(other.id, "same@example.net");
    expect(codeOf(duplicate.body)).toBe("forward_target_exists");
  });

  it("caps an organization's unconfirmed targets", async () => {
    const address = await createAddress();
    const rows = Array.from({ length: 20 }, (_, n) => ({
      id: `fwt_seed${n}`,
      organizationId: fixture.organizationId,
      addressId: address.id,
      email: `seed${n}@example.net`,
      tokenHash: `hash${n}`,
      tokenExpiresAt: new Date(Date.now() + 60_000),
    }));
    await db.insert(addressForwardTargets).values(rows);
    const other = await createAddress();
    const refused = await addTarget(other.id);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "forward_target_limit_reached", detail: { scope: "pending" } });
  });

  it("refuses an inbound host, a provider that can't send from it, strict DKIM, an inactive address and a test key", async () => {
    const address = await createAddress();
    expect(codeOf((await addTarget(address.id, "loop@inbound.example.com")).body)).toBe("validation_failed");

    dmarc.set("_dmarc.inbound.example.com", ["v=DMARC1; p=reject; adkim=s"]);
    const strict = await addTarget(address.id);
    expect(strict.body.error).toMatchObject({ code: "forward_not_allowed", detail: { reason: "strict_alignment" } });
    dmarc.clear();
    resetDnsCheckCache();

    await db.update(providers).set({ adapter: "mailpace" }).where(eq(providers.id, fixture.providerId));
    const incapable = await addTarget(address.id);
    expect(incapable.body.error).toMatchObject({ code: "forward_not_allowed", detail: { reason: "provider_incapable" } });
    await db.update(providers).set({ adapter: "mock" }).where(eq(providers.id, fixture.providerId));

    await revokeRoute(apiRequest(fixture.secret, `/v1/addresses/${address.id}`, "DELETE"), routeContext(address.id));
    expect(codeOf((await addTarget(address.id)).body)).toBe("address_inactive");

    const live = await createAddress();
    const test = await createApiKey({ organizationId: fixture.organizationId, name: "test", mode: "test", domainIds: [] });
    expect(codeOf((await addTarget(live.id, MAILBOX, test.secret)).body)).toBe("key_not_scoped");
    expect(await db.select().from(addressForwardTargets)).toEqual([]);
  });

  it("keeps another organization's address and targets out of reach", async () => {
    const address = await createAddress();
    const target = await confirmedTarget(address.id);
    const other = await seedFixture();

    const add = await addTarget(address.id, "x@example.net", other.secret);
    expect(add.status).toBe(404);
    const list = await call(listTargetsRoute(apiRequest(other.secret, "/x"), routeContext(address.id)));
    expect(list.status).toBe(404);
    const remove = await call(removeTargetRoute(apiRequest(other.secret, "/x", "DELETE"), targetContext(address.id, target.id)));
    expect(remove.status).toBe(404);
    const resend = await call(resendRoute(apiRequest(other.secret, "/x", "POST"), targetContext(address.id, target.id)));
    expect(resend.status).toBe(404);

    await db.update(domains).set({ inboundEnabled: true, inboundSubdomain: "mail" }).where(eq(domains.id, other.domainId));
    const otherAddress = await call(
      createAddressRoute(apiRequest(other.secret, "/v1/addresses", "POST", { domain_id: other.domainId, expires_in: 3600 })),
    );
    expect(otherAddress.status).toBe(201);
    const readAcross = await call(readTargetRoute(apiRequest(other.secret, "/x"), targetContext(otherAddress.body.id as string, target.id)));
    expect(readAcross.status).toBe(404);
    expect((await readTarget(address.id, target.id)).status).toBe("confirmed");
  });
});

describe("forwarding", () => {
  it("sends nothing to an unconfirmed target", async () => {
    const address = await createAddress();
    await addTarget(address.id);
    await ingest(mail(address.address));
    await drain();
    expect(await db.select().from(addressForwards)).toEqual([]);
    expect(await forwardsSent()).toEqual([]);
  });

  it("sends from the address as 'sender via address', Reply-To the sender, threaded, with the body, attachments and a stop link", async () => {
    const address = await createAddress({ localPart: "intake" });
    const target = await confirmedTarget(address.id);
    await ingest(
      mail(address.address, {
        html: "<html><body><p>See attached.</p></body></html>",
        headers: { References: "<root@example.net>", "Reply-To": "Billing <billing@example.net>" },
        attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4") }],
      }),
    );
    await drain();

    const [sent] = await forwardsSent();
    expect(sent).toMatchObject({ fromAddress: address.address, recipients: [MAILBOX], subject: "Invoice for September", apiKeyId: fixture.key.id, status: "queued" });
    expect(sent!.envelope.fromName).toBe(`Ada Lovelace via ${address.address}`);
    expect(sent!.envelope.replyTo).toEqual(["billing@example.net"]);
    expect(sent!.envelope.headers).toMatchObject({
      "In-Reply-To": "<inv-1@example.net>",
      References: "<root@example.net> <inv-1@example.net>",
      "List-Unsubscribe": `<${forwardStopUrl(target.id)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(JSON.stringify(sent!.envelope)).not.toMatch(/"from":"ada@example\.net"/);

    const body = await readBody(Buffer.from(sent!.bodyKey!, "base64"), sent!.storageKey!);
    expect(body.text).toContain("See attached.");
    expect(body.text).toContain(`Forwarded from ada@example.net by ${address.address}.`);
    expect(body.html).toMatch(/<p>See attached\.<\/p><hr>.*Stop these forwards<\/a><\/p><\/body><\/html>$/);
    expect(body.attachments).toEqual([{ filename: "invoice.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4").toString("base64") }]);

    expect(await readTarget(address.id, target.id)).toMatchObject({ forwarded_count: 1 });
    const read = await call(readAddressRoute(apiRequest(fixture.secret, `/v1/addresses/${address.id}`), routeContext(address.id)));
    expect((read.body.counts as Record<string, number>).forwarded).toBe(1);
  });

  it("uses the sender's address when there's no name, and never puts the sender's domain in From", async () => {
    const address = await createAddress();
    await confirmedTarget(address.id);
    await ingest(mail(address.address, { from: { name: null, address: "ada@example.net" } }));
    await drain();
    const [sent] = await forwardsSent();
    expect(sent!.envelope).toMatchObject({ from: address.address, fromName: `ada@example.net via ${address.address}`, replyTo: ["ada@example.net"] });
  });

  it("sends a message once, however often the worker runs it", async () => {
    const address = await createAddress();
    await confirmedTarget(address.id);
    await ingest(mail(address.address));
    const [forward] = await db.select().from(addressForwards);
    await sendForward(forward!.id);
    await db.update(addressForwards).set({ status: "pending" }).where(eq(addressForwards.id, forward!.id));
    await sendForward(forward!.id);
    expect(await forwardsSent()).toHaveLength(1);
  });

  it("never forwards spam, a DMARC failure or a virus, while the webhook still hears the flagged mail", async () => {
    const address = await createAddress();
    await confirmedTarget(address.id);
    await createEndpoint({ organizationId: fixture.organizationId, apiKeyId: fixture.key.id, url: "https://agent.example.net/hook", events: ["address.received"] });
    const verdicts = { spam: "pass", virus: "pass", spf: "pass", dkim: "pass", dmarc: "pass" };

    await ingest(mail(address.address, { verdicts: { ...verdicts, spam: "fail" } }));
    await ingest(mail(address.address, { verdicts: { ...verdicts, dmarc: "fail" } }));
    await ingest(mail(address.address, { verdicts: { ...verdicts, virus: "fail" } }));
    await drain();

    expect(await db.select().from(addressForwards)).toEqual([]);
    expect(await forwardsSent()).toEqual([]);
    const delivered = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventType, "address.received"));
    expect(delivered.map((row) => (row.payload as { data: { flags: string[] } }).data.flags)).toEqual(expect.arrayContaining([["spam"], ["dmarc"]]));
    expect(delivered).toHaveLength(2);

    await ingest(mail(address.address, { verdicts }));
    await drain();
    expect(await forwardsSent()).toHaveLength(1);
  });

  it("forwards nothing after expiry or revocation, including a forward queued before it", async () => {
    const address = await createAddress();
    await confirmedTarget(address.id);
    await ingest(mail(address.address));
    await revokeRoute(apiRequest(fixture.secret, `/v1/addresses/${address.id}`, "DELETE"), routeContext(address.id));
    await drain();
    const [queued] = await db.select().from(addressForwards);
    expect(queued).toMatchObject({ status: "skipped", reason: "address_inactive" });

    const expiring = await createAddress();
    await confirmedTarget(expiring.id, "two@example.net");
    await db.update(addresses).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(addresses.id, expiring.id));
    await ingest(mail(expiring.address));
    await drain();
    expect(await forwardsSent()).toEqual([]);
    expect(await db.select().from(addressForwards).where(eq(addressForwards.addressId, expiring.id))).toEqual([]);
  });

  it("forwards only what the address admits under its cap", async () => {
    const address = await createAddress({ messageCap: 1 });
    await confirmedTarget(address.id);
    await ingest(mail(address.address));
    await ingest(mail(address.address));
    await drain();
    expect(await forwardsSent()).toHaveLength(1);
    const [row] = await db.select().from(addresses).where(eq(addresses.id, address.id));
    expect(row).toMatchObject({ receivedCount: 1, droppedOverLimitCount: 1, forwardedCount: 1 });
  });

  it("applies suppression, and shows the refusal on the target", async () => {
    const address = await createAddress();
    const target = await confirmedTarget(address.id);
    await addSuppression(fixture.organizationId, MAILBOX);
    await ingest(mail(address.address));
    await drain();
    expect(await forwardsSent()).toEqual([]);
    const [forward] = await db.select().from(addressForwards);
    expect(forward).toMatchObject({ status: "failed", reason: "recipient_suppressed" });
    expect((await readTarget(address.id, target.id)).last_failure).toMatchObject({ code: "recipient_suppressed" });
  });

  it("stops forwarding to a removed target, queued forwards included", async () => {
    const address = await createAddress();
    const target = await confirmedTarget(address.id);
    await ingest(mail(address.address));
    const removed = await call(removeTargetRoute(apiRequest(fixture.secret, "/x", "DELETE"), targetContext(address.id, target.id)));
    expect(removed.status).toBe(200);
    await drain();
    expect(await forwardsSent()).toEqual([]);
  });
});

describe("disabling a target", () => {
  async function forwardOnce(addressId: string, addressText: string) {
    await ingest(mail(addressText));
    await drain();
    const [sent] = await forwardsSent();
    await db.update(messages).set({ status: "sent", providerId: fixture.providerId, providerMessageId: `prov-${sent!.id}` }).where(eq(messages.id, sent!.id));
    return `prov-${sent!.id}`;
  }

  for (const [status, reason] of [
    ["bounced", "bounced"],
    ["complained", "complained"],
  ] as const) {
    it(`disables the target when a forward is ${status}, and the owner can see why`, async () => {
      const address = await createAddress();
      const target = await confirmedTarget(address.id);
      const providerMessageId = await forwardOnce(address.id, address.address);

      await applyEvent(eventSource(fixture), {
        providerMessageId,
        providerEventId: `evt-${status}`,
        status,
        reason: "550 5.1.1 no such user",
        occurredAt: new Date(),
        detail: {},
        recipients: [MAILBOX],
      });

      const listed = await call(listTargetsRoute(apiRequest(fixture.secret, "/x"), routeContext(address.id)));
      expect((listed.body.data as Target[])[0]).toMatchObject({ id: target.id, status: "disabled", disabled_reason: reason });

      await ingest(mail(address.address, { providerMessageId: "after" }));
      expect(await db.select().from(addressForwards).where(eq(addressForwards.status, "pending"))).toEqual([]);
    });
  }

  it("lets the mailbox stop forwards with the stop link or one-click unsubscribe", async () => {
    const address = await createAddress();
    const target = await confirmedTarget(address.id);
    const token = forwardStopUrl(target.id).split("/").at(-1)!;

    const page = await stopPage(new Request("http://localhost"), tokenContext(token));
    expect(await page.text()).toContain("Stop forwarding");
    expect((await readTarget(address.id, target.id)).status).toBe("confirmed");

    expect((await stopPost(new Request("http://localhost", { method: "POST" }), tokenContext(`${token}x`))).status).toBe(404);
    const oneClick = await stopPost(new Request("http://localhost", { method: "POST", body: "List-Unsubscribe=One-Click" }), tokenContext(token));
    expect(oneClick.status).toBe(200);
    expect(await readTarget(address.id, target.id)).toMatchObject({ status: "disabled", disabled_reason: "stopped" });

    await ingest(mail(address.address));
    await drain();
    expect(await forwardsSent()).toEqual([]);
  });

  it("a stop link touches only its own target", async () => {
    const address = await createAddress();
    const first = await confirmedTarget(address.id);
    const second = await confirmedTarget(address.id, "two@example.net");
    await stopPost(new Request("http://localhost", { method: "POST" }), tokenContext(forwardStopUrl(first.id).split("/").at(-1)!));
    expect((await readTarget(address.id, second.id)).status).toBe("confirmed");
  });
});
