import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAdapter, capabilitiesOf } from "@/lib/providers/adapters";
import { mockSends, resetMockSends } from "@/lib/providers/adapters/mock";
import { SEND_TIMEOUT_MS } from "@/lib/providers/adapters/mailpace";
import type { OutboundMessage } from "@/lib/providers/adapters/types";

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

describe("receipt shape", () => {
  beforeEach(() => resetMockSends());

  it("records every message it accepts", async () => {
    await buildAdapter("mock", {}).send(outbound(["one@example.net"]));
    await buildAdapter("mock", {}).send(outbound(["two@example.net"]));

    expect(mockSends().map((entry) => entry.message.to[0])).toEqual(["one@example.net", "two@example.net"]);
  });

  it("refuses an unknown adapter rather than sending nowhere", () => {
    expect(() => buildAdapter("carrier-pigeon", {})).toThrow(/carrier-pigeon/);
  });

  it("reads capabilities from the adapter registry, not a live provider instance", () => {
    expect(capabilitiesOf("mailpace")).toEqual({
      customHeaders: false,
      maxAttachmentBytes: 20 * 1024 * 1024,
      maxRecipients: 50,
      bulk: false,
      domainsViaApi: true,
      dnsRecordsViaApi: true,
      webhooksViaApi: false,
      removalViaApi: false,
      adoptionViaApi: false,
      credentialsWithoutConsole: false,
      sharing: false,
      subdomainSending: false,
    });
    expect(() => capabilitiesOf("carrier-pigeon")).toThrow(/carrier-pigeon/);
  });

  it("leaves inbound unimplemented on the mock adapter", () => {
    expect(buildAdapter("mock", {}).inbound).toBeUndefined();
  });

  it("implements inbound on mailpace", () => {
    expect(buildAdapter("mailpace", { serverToken: "x" }).inbound).toBeDefined();
  });
});

describe("mailpace adapter", () => {
  it("classifies a 429 as backoff, a 5xx as transient and a 4xx as permanent", async () => {
    const cases = [
      { status: 429, body: { error: "You are sending emails too quickly" }, failure: "backoff" },
      { status: 503, body: { error: "upstream unavailable" }, failure: "transient" },
      { status: 400, body: { errors: { to: ["is invalid"] } }, failure: "permanent" },
    ] as const;

    for (const testCase of cases) {
      const provider = buildAdapter("mailpace", { serverToken: "token" });
      const original = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(JSON.stringify(testCase.body), { status: testCase.status, headers: { "content-type": "application/json" } });

      try {
        const receipt = await provider.send(outbound(["person@example.net"]));
        if (receipt.successful) throw new Error("expected a failed receipt");
        expect(receipt.failure).toBe(testCase.failure);
      } finally {
        globalThis.fetch = original;
      }
    }
  });

  it("quotes the provider's reason verbatim", async () => {
    const provider = buildAdapter("mailpace", { serverToken: "token" });
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ errors: { to: ["contains a blocked address"] } }), { status: 400 });

    try {
      const receipt = await provider.send(outbound(["person@example.net"]));
      if (receipt.successful) throw new Error("expected a failed receipt");
      expect(receipt.errors).toEqual(["to: contains a blocked address"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("treats a network throw as transient rather than losing the message", async () => {
    const provider = buildAdapter("mailpace", { serverToken: "token" });
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("ECONNRESET");
    };

    try {
      const receipt = await provider.send(outbound(["person@example.net"]));
      if (receipt.successful) throw new Error("expected a failed receipt");
      expect(receipt.failure).toBe("transient");
      expect(receipt.errors).toEqual(["ECONNRESET"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("gives up on a hung request instead of outliving the lock timeout", async () => {
    vi.useFakeTimers();
    try {
      const provider = buildAdapter("mailpace", { serverToken: "token" });
      const original = globalThis.fetch;
      globalThis.fetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () => {
            reject((init as RequestInit).signal?.reason);
          });
        });

      try {
        const pending = provider.send(outbound(["person@example.net"]));
        await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
        const receipt = await pending;

        if (receipt.successful) throw new Error("expected a failed receipt");
        expect(receipt.failure).toBe("transient");
        expect(receipt.errors[0]).toMatch(/timed out/);
      } finally {
        globalThis.fetch = original;
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a body that stalls after the headers arrive", async () => {
    vi.useFakeTimers();
    try {
      const provider = buildAdapter("mailpace", { serverToken: "token" });
      const original = globalThis.fetch;
      globalThis.fetch = async (_url, init) => {
        const signal = (init as RequestInit).signal;
        const stalled = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal.reason));
          },
        });
        return new Response(stalled, { status: 200, headers: { "content-type": "application/json" } });
      };

      try {
        const pending = provider.send(outbound(["person@example.net"]));
        await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
        const receipt = await pending;

        if (receipt.successful) throw new Error("expected a failed receipt");
        expect(receipt.failure).toBe("transient");
        expect(receipt.errors[0]).toMatch(/timed out/);
      } finally {
        globalThis.fetch = original;
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the body Mailpace expects, with joined recipients", async () => {
    const provider = buildAdapter("mailpace", { serverToken: "token" });
    const original = globalThis.fetch;
    let captured: Record<string, unknown> = {};
    globalThis.fetch = async (_url, init) => {
      captured = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 4210, status: "pending" }), { status: 200 });
    };

    try {
      const message = outbound(["one@example.net", "two@example.net"]);
      message.cc = ["cc@example.net"];
      const receipt = await provider.send(message);

      expect(captured.to).toBe("one@example.net,two@example.net");
      expect(captured.cc).toBe("cc@example.net");
      expect(captured.from).toBe("Ada <ada@example.com>");
      expect(captured.htmlbody).toBe("<p>Hello</p>");
      expect(captured).not.toHaveProperty("bcc");
      if (!receipt.successful) throw new Error("expected a successful receipt");
      expect(receipt.providerMessageId).toBe("4210");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps a non-JSON error body as a transient receipt with the status", async () => {
    const provider = buildAdapter("mailpace", { serverToken: "token" });
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } });

    try {
      const receipt = await provider.send(outbound(["person@example.net"]));
      if (receipt.successful) throw new Error("expected a failed receipt");
      expect(receipt.failure).toBe("transient");
      expect(receipt.errors).toContain("HTTP 502");
    } finally {
      globalThis.fetch = original;
    }
  });

  // `verify` reports `verified: body.dkim_verified === true`, so the DKIM TXT is the only
  // record required to send; the return-path CNAME and SPF TXT aren't checked.
  it("marks only the DKIM record required, on both create and verify", async () => {
    const provider = buildAdapter("mailpace", { serverToken: "token", organizationToken: "org" });
    const original = globalThis.fetch;
    const domainBody = {
      id: 99,
      dkim_host: "pm-bounces._domainkey.example.com",
      dkim_value: "k=rsa; p=abc",
      return_path_domain: "pm-bounces.example.com",
      return_path_value: "pm.mtasv.net",
      spf_value: "v=spf1 include:mailpace.com ~all",
    };
    globalThis.fetch = async () => new Response(JSON.stringify(domainBody), { status: 200 });

    try {
      const created = await provider.domain.create("example.com");
      expect(created.records).toEqual([
        { type: "TXT", name: "pm-bounces._domainkey.example.com", value: "k=rsa; p=abc", required: true },
        { type: "CNAME", name: "pm-bounces.example.com", value: "pm.mtasv.net", required: false },
        { type: "TXT", name: "example.com", value: "v=spf1 include:mailpace.com ~all", merge: "spf", required: false },
      ]);

      globalThis.fetch = async () =>
        new Response(JSON.stringify({ ...domainBody, dkim_verified: true, errors: {} }), { status: 200 });
      const status = await provider.domain.verify("example.com", "99");
      expect(status.verified).toBe(true);
      // verify() derives records from the same fields create() saw, so they carry the same flags.
      expect(status.missing).toEqual(created.records);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("has no remove, since Mailpace has no domain-delete endpoint", () => {
    const provider = buildAdapter("mailpace", { serverToken: "token", organizationToken: "org" });
    expect(provider.domain.remove).toBeUndefined();
    expect(capabilitiesOf("mailpace").removalViaApi).toBe(false);
  });
});

describe("health checks", () => {
  it("declares one on every registered adapter, so adding an adapter can't skip it", () => {
    const providers: Record<string, Record<string, string>> = {
      mailpace: { serverToken: "t" },
      mock: {},
      ses: { accessKeyId: "a", secretAccessKey: "s", region: "us-west-2" },
    };
    for (const [adapter, credentials] of Object.entries(providers)) {
      expect(typeof buildAdapter(adapter, credentials).healthCheck, adapter).toBe("function");
    }
  });

  it("is always ok for the mock provider", async () => {
    expect(await buildAdapter("mock", {}).healthCheck()).toEqual({ ok: true, detail: null });
  });

  it("reports mailpace as unprobeable without an organization token, leaving health to send outcomes", async () => {
    const result = await buildAdapter("mailpace", { serverToken: "t" }).healthCheck();
    expect(result.ok).toBeNull();
    expect(result.detail).toMatch(/per domain/i);
  });

  it("probes mailpace's domains endpoint with the organization token when one is configured", async () => {
    const provider = buildAdapter("mailpace", { serverToken: "t", organizationToken: "org" });
    const original = globalThis.fetch;
    let usedToken: string | null = null;
    globalThis.fetch = async (_url, init) => {
      usedToken = ((init as RequestInit).headers as Record<string, string>)["MailPace-Organization-Token"] ?? null;
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      expect(await provider.healthCheck()).toEqual({ ok: true, detail: null });
      expect(usedToken).toBe("org");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("categorizes a mailpace credential rejection instead of echoing the response body", async () => {
    const provider = buildAdapter("mailpace", { serverToken: "t", organizationToken: "bad" });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid token" }), { status: 401 });

    try {
      expect(await provider.healthCheck()).toEqual({ ok: false, detail: "Credentials were rejected." });
    } finally {
      globalThis.fetch = original;
    }
  });
});
