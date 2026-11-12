import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAdapter } from "@/lib/providers/adapters";
import type { OutboundMessage, SignedRequest } from "@/lib/providers/adapters/types";

function outbound(to: string[]): OutboundMessage {
  return {
    id: "msg_test",
    from: { name: "Ada", address: "ada@example.com" },
    to,
    cc: [],
    bcc: [],
    replyTo: [],
    subject: "Hello",
    html: "<p>Hello</p>",
    text: null,
    headers: {},
    tags: [],
    attachments: [],
  };
}

function credentials() {
  return { apiToken: "token", accountId: "cf_acct_1" };
}

describe("cloudflare adapter", () => {
  it("sends the body Cloudflare expects and reads the message id back", async () => {
    const provider = buildAdapter("cloudflare", credentials());
    const original = globalThis.fetch;
    let captured: Record<string, unknown> = {};
    let url = "";
    globalThis.fetch = async (input, init) => {
      url = String(input);
      captured = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ success: true, errors: [], result: { message_id: "msg_abc" } }), { status: 200 });
    };

    try {
      const message = outbound(["one@example.net"]);
      message.cc = ["cc@example.net"];
      const receipt = await provider.send(message);

      expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/cf_acct_1/email/sending/send");
      expect(captured.to).toEqual(["one@example.net"]);
      expect(captured.cc).toEqual(["cc@example.net"]);
      expect(captured.from).toEqual({ address: "ada@example.com", name: "Ada" });
      expect(captured).not.toHaveProperty("bcc");
      if (!receipt.successful) throw new Error("expected a successful receipt");
      expect(receipt.providerMessageId).toBe("msg_abc");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("classifies a 429 as backoff, a 5xx as transient and a 4xx as permanent", async () => {
    const cases = [
      { status: 429, body: { success: false, errors: [{ code: 10004, message: "throttled" }] }, failure: "backoff" },
      { status: 503, body: { success: false, errors: [{ code: 10100, message: "upstream" }] }, failure: "transient" },
      { status: 400, body: { success: false, errors: [{ code: 10001, message: "invalid_request_schema" }] }, failure: "permanent" },
    ] as const;

    for (const testCase of cases) {
      const provider = buildAdapter("cloudflare", credentials());
      const original = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify(testCase.body), { status: testCase.status });

      try {
        const receipt = await provider.send(outbound(["person@example.net"]));
        if (receipt.successful) throw new Error("expected a failed receipt");
        expect(receipt.failure).toBe(testCase.failure);
      } finally {
        globalThis.fetch = original;
      }
    }
  });

  it("treats account-level sending being disabled as backoff, not a permanent per-message failure", async () => {
    const provider = buildAdapter("cloudflare", credentials());
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10203, message: "sending_disabled" }] }), { status: 403 });

    try {
      const receipt = await provider.send(outbound(["person@example.net"]));
      if (receipt.successful) throw new Error("expected a failed receipt");
      expect(receipt.failure).toBe("backoff");
      expect(receipt.retryAfterSeconds).toBe(15 * 60);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("resolves the domain's zone before creating a sending subdomain, trying suffixes down to the registrable domain", async () => {
    const provider = buildAdapter("cloudflare", credentials());
    const original = globalThis.fetch;
    const calledUrls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calledUrls.push(url);
      if (url.includes("/zones?name=notify.example.com")) {
        return new Response(JSON.stringify({ success: true, errors: [], result: [] }), { status: 200 });
      }
      if (url.includes("/zones?name=example.com")) {
        return new Response(JSON.stringify({ success: true, errors: [], result: [{ id: "zone_1" }] }), { status: 200 });
      }
      if (url.includes("/subdomains") && !url.includes("/dns")) {
        return new Response(JSON.stringify({ success: true, errors: [], result: { tag: "tag_1" } }), { status: 200 });
      }
      if (url.endsWith("/dns")) {
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [{ type: "TXT", name: "cf-bounce._domainkey.notify.example.com", content: '"v=DKIM1; k=rsa; p=abc"' }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected call to ${url}`);
    };

    try {
      const created = await provider.domain.create("notify.example.com");
      expect(created.providerDomainId).toBe("zone_1:tag_1");
      expect(created.records).toEqual([
        { type: "TXT", name: "cf-bounce._domainkey.notify.example.com", value: "v=DKIM1; k=rsa; p=abc", required: true },
      ]);
      expect(calledUrls.some((url) => url.includes("/zones?name=notify.example.com"))).toBe(true);
      expect(calledUrls.some((url) => url.includes("/zones?name=example.com"))).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("throws when no Cloudflare zone hosts the domain", async () => {
    const provider = buildAdapter("cloudflare", credentials());
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, errors: [], result: [] }), { status: 200 });

    try {
      await expect(provider.domain.create("elsewhere.com")).rejects.toThrow(/No Cloudflare zone/);
    } finally {
      globalThis.fetch = original;
    }
  });

  // `enabled` is the only per-domain readiness signal Cloudflare's API exposes — it's the zone's
  // own DNS host, so there's no external record left to poll the way SES's DKIM check needs.
  it("keys verified off `enabled`, since Cloudflare has no separate DNS-verification status", async () => {
    const provider = buildAdapter("cloudflare", credentials());
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/dns")) return new Response(JSON.stringify({ success: true, errors: [], result: [] }), { status: 200 });
      return new Response(JSON.stringify({ success: true, errors: [], result: { enabled: true } }), { status: 200 });
    };

    try {
      const status = await provider.domain.verify("notify.example.com", "zone_1:tag_1");
      expect(status).toEqual({ answered: true, verified: true, missing: [], errors: [] });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports unanswered when the domain has no provider id yet", async () => {
    const provider = buildAdapter("cloudflare", credentials());
    const status = await provider.domain.verify("notify.example.com", null);
    expect(status.answered).toBe(false);
    expect(status.verified).toBe(false);
  });

  it.each([
    [500, { success: false, errors: [{ code: 10000, message: "upstream" }] }, "upstream"],
    [403, { success: false, errors: [] }, "HTTP 403"],
  ])("surfaces a failed remove (HTTP %i)", async (status, body, message) => {
    const provider = buildAdapter("cloudflare", credentials());
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(body), { status });

    try {
      await expect(provider.domain.remove!("notify.example.com", "zone_1:tag_1")).rejects.toThrow(message);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("treats a sending subdomain Cloudflare already forgot as removed", async () => {
    const provider = buildAdapter("cloudflare", credentials());
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "not found" }] }), { status: 404 });

    try {
      await expect(provider.domain.remove!("notify.example.com", "zone_1:tag_1")).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports the Cloudflare account id as identity when the token can reach it", async () => {
    const provider = buildAdapter("cloudflare", credentials());
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, errors: [], result: { id: "cf_acct_1" } }), { status: 200 });

    try {
      expect(await provider.identity?.()).toBe("cf_acct_1");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports identity as null rather than trusting the credential when the account is unreachable", async () => {
    const provider = buildAdapter("cloudflare", credentials());
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ success: false, errors: [{ code: 9109, message: "invalid" }] }), { status: 401 });

    try {
      expect(await provider.identity?.()).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("categorizes a health check credential rejection instead of echoing the response body", async () => {
    const provider = buildAdapter("cloudflare", credentials());
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ success: false, errors: [] }), { status: 403 });

    try {
      expect(await provider.healthCheck()).toEqual({ ok: false, detail: "Credentials were rejected." });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("cloudflare webhook signatures", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

  function signed(rawBody: string, privateKey = keys.privateKey): SignedRequest {
    return {
      rawBody,
      headers: { "x-cloudflare-worker-signature": sign(null, Buffer.from(rawBody), privateKey).toString("base64") },
    };
  }

  function provider(settings: Record<string, string> = { webhookPublicKey: publicKey }) {
    return buildAdapter("cloudflare", { apiToken: "t", accountId: "cf_acct_1" }, settings);
  }

  const delivered = JSON.stringify({
    type: "cf.email.sending.message.delivered",
    eventId: "q_1",
    source: { type: "email.sending", zoneId: "zone_1", domain: "example.com" },
    payload: { messageId: "msg_abc", recipient: "person@example.net", terminal: true, delivery: { status: "delivered", smtpStatusCode: "250" } },
  });

  it("accepts a body signed with the Worker's key", async () => {
    expect(await provider().events.verify(signed(delivered))).toBe(true);
  });

  it("rejects a body signed with another key", async () => {
    const attacker = generateKeyPairSync("ed25519");
    expect(await provider().events.verify(signed(delivered, attacker.privateKey))).toBe(false);
  });

  it("rejects everything when the account has no webhook key", async () => {
    expect(await provider({}).events.verify(signed(delivered))).toBe(false);
  });

  it("maps every documented event type to a lifecycle status", () => {
    const cases: [string, string][] = [
      ["cf.email.sending.message.delivered", "delivered"],
      ["cf.email.sending.message.deferred", "deferred"],
      ["cf.email.sending.message.bounced", "bounced"],
      ["cf.email.sending.message.failed", "failed"],
      ["cf.email.sending.message.rejected", "failed"],
      ["cf.email.sending.message.complained", "complained"],
    ];

    for (const [type, expected] of cases) {
      const body = JSON.stringify({ type, eventId: "q_1", payload: { messageId: "msg_abc", recipient: "person@example.net" } });
      const [event] = provider().events.parse({ rawBody: body, headers: {} });
      expect(event?.status, type).toBe(expected);
      expect(event?.providerMessageId).toBe("msg_abc");
      expect(event?.recipients).toEqual(["person@example.net"]);
    }
  });

  it("ignores an event it doesn't map rather than guessing", () => {
    const body = JSON.stringify({ type: "cf.email.sending.message.opened", payload: { messageId: "msg_abc" } });
    expect(provider().events.parse({ rawBody: body, headers: {} })).toEqual([]);
  });

  it("dates an event from Cloudflare's eventTimestamp, not from when it arrived", () => {
    const body = JSON.stringify({
      ...JSON.parse(delivered),
      metadata: { eventSchemaVersion: 1, eventTimestamp: "2026-06-01T02:48:57.132Z" },
    });
    const [event] = provider().events.parse({ rawBody: body, headers: {} });
    expect(event?.occurredAt.toISOString()).toBe("2026-06-01T02:48:57.132Z");
  });

  it("falls back to the arrival time when eventTimestamp is missing or unreadable", () => {
    const body = JSON.stringify({ ...JSON.parse(delivered), metadata: { eventTimestamp: "not a date" } });
    const before = Date.now();
    for (const raw of [delivered, body]) {
      const [event] = provider().events.parse({ rawBody: raw, headers: {} });
      expect(event?.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it("gives a retried event the same event id, from the Worker's own queue message id", () => {
    const [event] = provider().events.parse({ rawBody: delivered, headers: {} });
    expect(event?.providerEventId).toBe("q_1");
  });
});
