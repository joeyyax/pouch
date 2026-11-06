import { generateKeyPairSync, sign } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { domains, inboundMessages, webhookDeliveries } from "@/lib/db/schema";
import { receiveInbound } from "@/lib/inbound/ingest";
import { readInboundBody } from "@/lib/inbound/attachments";
import { upsertDomainEndpoint } from "@/lib/webhooks/endpoints";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

// upsertDomainEndpoint checks the URL is safe to register, which resolves the hostname — stub it
// to a public address so the test doesn't depend on real DNS.
vi.mock("node:dns/promises", () => ({ lookup: () => Promise.resolve([{ address: "203.0.113.9", family: 4 }]) }));

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

function signed(rawBody: string, privateKey = keys.privateKey) {
  return { rawBody, headers: { "x-mailpace-signature": sign(null, Buffer.from(rawBody), privateKey).toString("base64") } };
}

function inboundPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 501,
    from: "Ada Lovelace <ada@example.net>",
    to: "reply@inbound.example.com",
    subject: "Re: hello",
    text: "hi there",
    headers: { "x-mailer": "test" },
    messageId: "<ada-1@example.net>",
    ...overrides,
  });
}

async function enableInbound(fixture: Fixture, url = "https://receiver.example.net/hook") {
  await db
    .update(domains)
    .set({ inboundEnabled: true, inboundProviderSettings: { webhookPublicKey: publicKey } })
    .where(eq(domains.id, fixture.domainId));
  return upsertDomainEndpoint(fixture.organizationId, fixture.domainId, url);
}

beforeEach(resetDatabase);
afterEach(resetDatabase);

describe("receiving inbound mail", () => {
  it("rejects a callback for a domain inbound isn't enabled on", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    const outcome = await receiveInbound("mailpace", fixture.domainId, signed(inboundPayload()));
    expect(outcome.verified).toBe(false);
  });

  it("rejects a callback signed with the wrong key", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    await enableInbound(fixture);
    const attacker = generateKeyPairSync("ed25519");

    const outcome = await receiveInbound("mailpace", fixture.domainId, signed(inboundPayload(), attacker.privateKey));
    expect(outcome.verified).toBe(false);
  });

  it("persists a verified message and enqueues its inbound.received delivery", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    await enableInbound(fixture);

    const outcome = await receiveInbound("mailpace", fixture.domainId, signed(inboundPayload()));
    expect(outcome.verified).toBe(true);
    expect(outcome.result).toEqual({ accepted: 1, duplicates: 0 });

    const [row] = await db.select().from(inboundMessages).where(eq(inboundMessages.domainId, fixture.domainId));
    expect(row?.fromAddress).toBe("ada@example.net");
    expect(row?.fromName).toBe("Ada Lovelace");
    expect(row?.subject).toBe("Re: hello");
    expect(row?.messageId).toBe("<ada-1@example.net>");
    expect(row?.text).toBeNull();
    expect(row?.bodyKey).not.toBeNull();
    expect(await readInboundBody(row!)).toEqual({ text: "hi there", html: null });

    const [delivery] = await db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.organizationId, fixture.organizationId), eq(webhookDeliveries.eventType, "inbound.received")));
    expect(delivery?.status).toBe("pending");
    expect((delivery?.payload as { data?: { id?: string } })?.data?.id).toBe(row?.id);
    expect((delivery?.payload as { data?: { text?: string } })?.data?.text).toBe("hi there");
  });

  it.each([
    {
      name: "matches in-reply-to to a sent message by provider message id",
      stored: "outbound-abc",
      overrides: { inReplyTo: "<outbound-abc@example.com>" },
    },
    {
      name: "falls back to references when in-reply-to is missing",
      stored: "outbound-xyz",
      overrides: { headers: { References: "<older-1@example.net> <outbound-xyz@example.com>" } },
    },
    {
      name: "matches in-reply-to case-insensitively and despite folded whitespace",
      stored: "Outbound-ABC",
      overrides: { inReplyTo: "<outbound-abc\r\n @example.com>" },
    },
  ])("$name", async ({ stored, overrides }) => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    await enableInbound(fixture);

    const { messages } = await import("@/lib/db/schema");
    const { newId } = await import("@/lib/ids");
    const sentId = newId("message");
    await db.insert(messages).values({
      id: sentId,
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      status: "delivered",
      fromAddress: "us@example.com",
      recipients: ["ada@example.net"],
      subject: "Welcome",
      envelope: { from: "us@example.com", fromName: null, to: ["ada@example.net"], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
      providerMessageId: stored,
    });

    const outcome = await receiveInbound("mailpace", fixture.domainId, signed(inboundPayload(overrides)));
    expect(outcome.verified).toBe(true);

    const [row] = await db.select().from(inboundMessages).where(eq(inboundMessages.domainId, fixture.domainId));
    expect(row?.outboundMessageId).toBe(sentId);
  });

  it("keeps two sends whose provider ids share a local part apart", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    await enableInbound(fixture);

    const { messages } = await import("@/lib/db/schema");
    const { newId } = await import("@/lib/ids");
    const sent = {
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      status: "delivered" as const,
      fromAddress: "us@example.com",
      recipients: ["ada@example.net"],
      subject: "Welcome",
      envelope: { from: "us@example.com", fromName: null, to: ["ada@example.net"], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
    };
    const otherId = newId("message");
    const sentId = newId("message");
    await db.insert(messages).values([
      { ...sent, id: otherId, providerMessageId: "outbound-abc@first.example.com" },
      { ...sent, id: sentId, providerMessageId: "outbound-abc@second.example.com" },
    ]);

    const outcome = await receiveInbound(
      "mailpace",
      fixture.domainId,
      signed(inboundPayload({ inReplyTo: "<outbound-abc@second.example.com>" })),
    );
    expect(outcome.verified).toBe(true);

    const [row] = await db.select().from(inboundMessages).where(eq(inboundMessages.domainId, fixture.domainId));
    expect(row?.outboundMessageId).toBe(sentId);
  });

  it("dedupes a retried delivery on (domain, provider message id) without a second row or delivery", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    await enableInbound(fixture);

    const first = await receiveInbound("mailpace", fixture.domainId, signed(inboundPayload()));
    const second = await receiveInbound("mailpace", fixture.domainId, signed(inboundPayload()));

    expect(first.result).toEqual({ accepted: 1, duplicates: 0 });
    expect(second.result).toEqual({ accepted: 0, duplicates: 1 });

    const rows = await db.select().from(inboundMessages).where(eq(inboundMessages.domainId, fixture.domainId));
    expect(rows).toHaveLength(1);

    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.organizationId, fixture.organizationId), eq(webhookDeliveries.eventType, "inbound.received")));
    expect(deliveries).toHaveLength(1);
  });
});
