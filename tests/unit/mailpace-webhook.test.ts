import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { buildAdapter } from "@/lib/providers/adapters";
import type { SignedRequest } from "@/lib/providers/adapters/types";

const keys = generateKeyPairSync("ed25519");
/** Mailpace shows the raw 32-byte key base64-encoded, which is the SPKI tail. */
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

function signed(rawBody: string, privateKey = keys.privateKey): SignedRequest {
  return {
    rawBody,
    headers: { "x-mailpace-signature": sign(null, Buffer.from(rawBody), privateKey).toString("base64") },
  };
}

function provider(settings: Record<string, string> = { webhookPublicKey: publicKey }) {
  return buildAdapter("mailpace", { serverToken: "token" }, settings);
}

/** A delivery webhook as Mailpace posts it. */
const delivered = JSON.stringify({
  event: "email.delivered",
  payload: {
    status: "delivered",
    id: 4210,
    domain_id: 12,
    from: "ada@example.com",
    to: "person@example.net",
    subject: "Hello",
    created_at: "2026-09-08T10:00:00.000Z",
    updated_at: "2026-09-08T10:00:04.000Z",
  },
});

describe("mailpace webhook signatures", () => {
  it("accepts a body signed with the domain's key", async () => {
    expect(await provider().events.verify(signed(delivered))).toBe(true);
  });

  it("rejects a body signed with another key", async () => {
    const attacker = generateKeyPairSync("ed25519");

    expect(await provider().events.verify(signed(delivered, attacker.privateKey))).toBe(false);
  });

  it("rejects a body that changed after it was signed", async () => {
    const request = signed(delivered);
    request.rawBody = delivered.replace("delivered", "bounced");

    expect(await provider().events.verify(request)).toBe(false);
  });

  it("rejects an unsigned request", async () => {
    expect(await provider().events.verify({ rawBody: delivered, headers: {} })).toBe(false);
  });

  it("rejects a signature that isn't 64 bytes", async () => {
    expect(
      await provider().events.verify({ rawBody: delivered, headers: { "x-mailpace-signature": "bm90LWEtc2ln" } }),
    ).toBe(false);
  });

  it("rejects everything when the provider has no webhook key", async () => {
    expect(await provider({}).events.verify(signed(delivered))).toBe(false);
  });

  it("reads the signature header whatever its casing", async () => {
    const request = signed(delivered);
    const value = request.headers["x-mailpace-signature"] ?? "";

    expect(await provider().events.verify({ rawBody: delivered, headers: { "X-MailPace-Signature": value } })).toBe(true);
  });

  it("verifies a fixed key, signature and body, so the algorithm can't drift", async () => {
    // Ed25519 test vector from RFC 8032 section 7.1, TEST 2.
    const fixedPublicKey = Buffer.from("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "hex");
    const body = Buffer.from("72", "hex").toString("binary");
    const signature = Buffer.from(
      "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
      "hex",
    ).toString("base64");

    const fixed = buildAdapter("mailpace", { serverToken: "t" }, { webhookPublicKey: fixedPublicKey.toString("base64") });
    expect(await fixed.events.verify({ rawBody: body, headers: { "x-mailpace-signature": signature } })).toBe(true);
  });
});

describe("mailpace event shapes", () => {
  it("normalizes each recorded status to a lifecycle status", () => {
    const cases: [string, string][] = [
      ["queued", "sent"],
      ["delivered", "delivered"],
      ["deferred", "deferred"],
      ["bounced", "bounced"],
      ["spam", "complained"],
    ];

    for (const [status, expected] of cases) {
      const body = JSON.stringify({
        event: `email.${status}`,
        payload: { status, id: 4210, updated_at: "2026-09-08T10:00:04.000Z", error: null },
      });
      const [event] = provider().events.parse({ rawBody: body, headers: {} });
      expect(event?.status, status).toBe(expected);
      expect(event?.providerMessageId).toBe("4210");
    }
  });

  it("gives a retried webhook the same event id", () => {
    const [first] = provider().events.parse({ rawBody: delivered, headers: {} });
    const [second] = provider().events.parse({ rawBody: delivered, headers: {} });

    expect(first?.providerEventId).toBeTruthy();
    expect(first?.providerEventId).toBe(second?.providerEventId);
  });

  it("tells two events apart without updated_at, and still dedupes a retry", () => {
    const deferral = (error: string) =>
      JSON.stringify({ event: "email.deferred", payload: { status: "deferred", id: 4210, error } });
    const [first] = provider().events.parse({ rawBody: deferral("421 try later"), headers: {} });
    const [second] = provider().events.parse({ rawBody: deferral("451 greylisted"), headers: {} });
    const [retry] = provider().events.parse({ rawBody: deferral("421 try later"), headers: {} });

    expect(first?.providerEventId).not.toBe(second?.providerEventId);
    expect(retry?.providerEventId).toBe(first?.providerEventId);
  });

  it("keeps the event id it has always built when updated_at is there", () => {
    const [event] = provider().events.parse({ rawBody: delivered, headers: {} });

    expect(event?.providerEventId).toBe("4210:delivered:2026-09-08T10:00:04.000Z");
  });

  it("carries the provider's bounce reason verbatim", () => {
    const body = JSON.stringify({
      event: "email.bounced",
      payload: { status: "bounced", id: 7, error: "550 5.1.1 user unknown", updated_at: "2026-09-08T10:00:04.000Z" },
    });

    const [event] = provider().events.parse({ rawBody: body, headers: {} });

    expect(event?.reason).toBe("550 5.1.1 user unknown");
  });

  it("ignores an event it doesn't map rather than guessing", () => {
    const body = JSON.stringify({ event: "email.opened", payload: { status: "opened", id: 7 } });

    expect(provider().events.parse({ rawBody: body, headers: {} })).toEqual([]);
  });

  it("names the recipient the event is about", () => {
    const [event] = provider().events.parse({ rawBody: delivered, headers: {} });

    expect(event?.recipients).toEqual(["person@example.net"]);
  });

  it("names nobody when the To header lists more than one address", () => {
    // Mailpace's "to" is the full To header, comma-joined — with more than one recipient it
    // can't say which one the event is actually about.
    const body = JSON.stringify({
      event: "email.bounced",
      payload: { status: "bounced", id: 7, to: "person@example.net,other@example.net", updated_at: "2026-09-08T10:00:04.000Z" },
    });

    const [event] = provider().events.parse({ rawBody: body, headers: {} });

    expect(event?.recipients).toEqual([]);
  });

  it("names nobody when the provider sends no To header at all", () => {
    const body = JSON.stringify({
      event: "email.bounced",
      payload: { status: "bounced", id: 7, to: null, updated_at: "2026-09-08T10:00:04.000Z" },
    });

    const [event] = provider().events.parse({ rawBody: body, headers: {} });

    expect(event?.recipients).toEqual([]);
  });
});


/** A warn that names the provider id goes out so an operator can see why event delivery stopped. */
describe("mailpace webhook key parse warning", () => {
  let warn: MockInstance;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("warns with the provider id and the decoded length when the key isn't 32 bytes", async () => {
    const garbage = Buffer.alloc(8).toString("base64");
    const provider = buildAdapter("mailpace", { serverToken: "t" }, { webhookPublicKey: garbage }, "pac_alice");

    expect(await provider.events.verify(signed(delivered))).toBe(false);

    const messages = warn.mock.calls.flatMap((call) => call.slice(1).map((part) => String(part ?? "")));
    expect(messages.some((line) => line.includes("pac_alice") && line.includes("decoded to 8 bytes"))).toBe(true);
  });

  it("warns when the key fails to parse for any other reason, and verification still fails", async () => {
    // A bare string that contains neither a PEM marker nor decodes to 32 bytes after base64.
    const garbage = Buffer.from("not-base64-or-pem").toString("base64");
    const provider = buildAdapter("mailpace", { serverToken: "t" }, { webhookPublicKey: garbage }, "pac_bob");

    expect(await provider.events.verify(signed(delivered))).toBe(false);

    const messages = warn.mock.calls.flatMap((call) => call.slice(1).map((part) => String(part ?? "")));
    expect(messages.some((line) => line.includes("pac_bob"))).toBe(true);
  });
});
