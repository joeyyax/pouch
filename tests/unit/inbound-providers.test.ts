import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAdapter } from "@/lib/providers/adapters";
import type { SignedRequest } from "@/lib/providers/adapters/types";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

function signedWith(rawBody: string, header: string, privateKey = keys.privateKey): SignedRequest {
  return { rawBody, headers: { [header]: sign(null, Buffer.from(rawBody), privateKey).toString("base64") } };
}

describe("mailpace inbound", () => {
  const provider = buildAdapter("mailpace", { serverToken: "token" }, {});

  it("proposes a CNAME on the host it's given", () => {
    const records = provider.inbound!.records("inbound.example.com");
    expect(records).toEqual([{ type: "CNAME", name: "inbound.example.com", value: "inbound.mailpace.com", required: false }]);
  });

  it("verifies against the domain's own key, not the provider's", () => {
    const body = JSON.stringify({ from: "ada@example.net", headers: {}, messageId: "<1@example.net>" });
    const signed = signedWith(body, "x-mailpace-signature");

    expect(provider.inbound!.verify!(signed, { webhookPublicKey: publicKey })).toBe(true);
    // No key stored on this domain: the provider has one configured above, but that must not leak in.
    expect(provider.inbound!.verify!(signed, {})).toBe(false);
  });

  it("rejects a body signed with a different domain's key", () => {
    const attacker = generateKeyPairSync("ed25519");
    const body = JSON.stringify({ from: "ada@example.net", headers: {} });
    const signed = signedWith(body, "x-mailpace-signature", attacker.privateKey);

    expect(provider.inbound!.verify!(signed, { webhookPublicKey: publicKey })).toBe(false);
  });

  it("parses from, to, subject, text, html, headers, message id, in-reply-to and attachments", () => {
    const body = JSON.stringify({
      id: 991,
      from: "Ada Lovelace <ada@example.net>",
      to: "reply@inbound.example.com",
      subject: "Re: welcome",
      text: "thanks",
      html: "<p>thanks</p>",
      headers: { "x-custom": "1" },
      messageId: "<abc@example.net>",
      inReplyTo: "<xyz@example.com>",
      attachments: [{ filename: "a.txt", contentType: "text/plain", content: Buffer.from("hi").toString("base64") }],
    });

    const [message] = provider.inbound!.parse!({ rawBody: body, headers: {} });

    expect(message).toMatchObject({
      providerMessageId: "991",
      from: { name: "Ada Lovelace", address: "ada@example.net" },
      to: ["reply@inbound.example.com"],
      subject: "Re: welcome",
      text: "thanks",
      html: "<p>thanks</p>",
      headers: { "x-custom": "1" },
      messageId: "<abc@example.net>",
      inReplyTo: "<xyz@example.com>",
    });
    expect(message?.attachments).toEqual([{ filename: "a.txt", contentType: "text/plain", content: Buffer.from("hi") }]);
  });

  it("reads Mailpace's header lines into names and values, keeping the first of a repeated name", () => {
    const body = JSON.stringify({
      from: "ada@example.net",
      headers: ["Received: from a", "Received: from b", "References: <x@example.com>\t<y@example.com>", "In-Reply-To: <y@example.com>"],
      messageId: "<abc@example.net>",
      raw: "From: ada@example.net\r\n\r\nhi",
    });

    const [message] = provider.inbound!.parse!({ rawBody: body, headers: {} });

    expect(message?.headers).toEqual({
      Received: "from a",
      References: "<x@example.com>\t<y@example.com>",
      "In-Reply-To": "<y@example.com>",
    });
  });

  it("keeps the raw message and names a retry of it by its content, since Mailpace sends no id", () => {
    const raw = "From: ada@example.net\r\nSubject: hi\r\n\r\nhello";
    const first = provider.inbound!.parse!({ rawBody: JSON.stringify({ from: "ada@example.net", headers: [], raw }), headers: {} })[0];
    const retry = provider.inbound!.parse!({ rawBody: JSON.stringify({ from: "ada@example.net", headers: [], raw }), headers: {} })[0];
    const other = provider.inbound!.parse!({ rawBody: JSON.stringify({ from: "ada@example.net", headers: [], raw: `${raw}!` }), headers: {} })[0];

    expect(first?.raw?.toString("utf8")).toBe(raw);
    expect(first?.providerMessageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(retry?.providerMessageId).toBe(first?.providerMessageId);
    expect(other?.providerMessageId).not.toBe(first?.providerMessageId);
  });

  describe("recipients", () => {
    function recipients(body: Record<string, unknown>): string[] {
      const [message] = provider.inbound!.parse!({ rawBody: JSON.stringify({ from: "ada@example.net", headers: [], ...body }), headers: {} });
      return message!.to;
    }

    it("keeps a quoted \"Last, First\" display name with its address instead of splitting on the comma", () => {
      expect(recipients({ to: '"Lovelace, Ada" <Agent@Inbound.Example.com>' })).toEqual(["Agent@inbound.example.com"]);
    });

    it("returns bare addresses, lowercases the domain and drops repeats", () => {
      expect(recipients({ to: "A <a@Inbound.Example.com>, a@inbound.example.com", cc: "b@INBOUND.example.com" })).toEqual([
        "a@inbound.example.com",
        "b@inbound.example.com",
      ]);
    });

    it("includes cc and bcc when Mailpace fills them", () => {
      expect(recipients({ to: "a@inbound.example.com", cc: "b@inbound.example.com", bcc: "c@inbound.example.com" })).toEqual([
        "a@inbound.example.com",
        "b@inbound.example.com",
        "c@inbound.example.com",
      ]);
    });

    it("recovers a recipient the fields lack from Delivered-To, X-Original-To and a Received for clause", () => {
      expect(
        recipients({
          to: "list@example.org",
          headers: [
            "Delivered-To: bcc1@inbound.example.com",
            "X-Original-To: Bcc2 <bcc2@inbound.example.com>",
            "Received: from mx.example.net by inbound.mailpace.com with ESMTP id 1 for <bcc3@inbound.example.com>; Thu, 1 Oct 2026 00:00:00 +0000",
          ],
        }),
      ).toEqual(["list@example.org", "bcc1@inbound.example.com", "bcc2@inbound.example.com", "bcc3@inbound.example.com"]);
    });

    it("reads Delivered-To from the raw message's header block, not its body", () => {
      const raw = "From: ada@example.net\r\nDelivered-To: hidden@inbound.example.com\r\n\r\nDelivered-To: body@inbound.example.com\r\n";
      expect(recipients({ to: "a@inbound.example.com", raw })).toEqual(["a@inbound.example.com", "hidden@inbound.example.com"]);
    });

    it("never drops a field's recipient because a hint names someone else", () => {
      expect(recipients({ to: "a@inbound.example.com", headers: ["Delivered-To: z@inbound.example.com"] })).toEqual([
        "a@inbound.example.com",
        "z@inbound.example.com",
      ]);
    });
  });

  it("returns nothing for a body that isn't valid JSON", () => {
    expect(provider.inbound!.parse!({ rawBody: "not json", headers: {} })).toEqual([]);
  });
});

describe("cloudflare inbound", () => {
  const provider = buildAdapter("cloudflare", { apiToken: "t", providerId: "a" }, {});

  it("proposes three MX priorities and an SPF TXT on the inbound subdomain", () => {
    const records = provider.inbound!.records("inbound.example.com");
    expect(records).toHaveLength(4);
    expect(records.filter((r) => r.type === "MX").map((r) => r.priority)).toEqual([10, 20, 30]);
    expect(records.every((r) => r.name === "inbound.example.com" && r.required === false)).toBe(true);
  });

  it("verifies against the domain's own worker key", () => {
    const body = JSON.stringify({ from: { address: "ada@example.net" }, to: ["reply@inbound.example.com"], headers: {} });
    const signed = signedWith(body, "x-cloudflare-worker-signature");

    expect(provider.inbound!.verify!(signed, { webhookPublicKey: publicKey })).toBe(true);
    expect(provider.inbound!.verify!(signed, {})).toBe(false);
  });

  it("parses the forwarded Worker payload, reading message id and in-reply-to off headers", () => {
    const body = JSON.stringify({
      messageId: "cf-1",
      from: { name: "Ada", address: "ada@example.net" },
      to: ["reply@inbound.example.com"],
      subject: "hello",
      text: "hi",
      headers: { "message-id": "<a@b>", "in-reply-to": "<c@d>" },
      attachments: [{ filename: "a.txt", contentType: "text/plain", content: "aGk=" }],
    });

    const [message] = provider.inbound!.parse!({ rawBody: body, headers: {} });

    expect(message).toMatchObject({
      providerMessageId: "cf-1",
      from: { name: "Ada", address: "ada@example.net" },
      messageId: "<a@b>",
      inReplyTo: "<c@d>",
    });
  });

  it("drops a message with no from address rather than guessing", () => {
    const body = JSON.stringify({ headers: {} });
    expect(provider.inbound!.parse!({ rawBody: body, headers: {} })).toEqual([]);
  });
});
