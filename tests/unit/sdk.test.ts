import { describe, expect, it, vi } from "vitest";
import { PouchClient, PouchError } from "../../sdk/pouch";

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof PouchClient>[0]> = {}) {
  return new PouchClient({ apiKey: "sk_test_abc", baseUrl: "https://api.example.test", fetch: fetchImpl, ...extra });
}

describe("PouchClient error mapping", () => {
  it("throws a PouchError with code, message, field, detail and status from the error envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "domain_not_verified",
            message: "Domain example.com isn't verified. Add the listed DNS records and verify.",
            field: "from",
            detail: { missing_records: ["TXT"] },
          },
        },
        422,
      ),
    );

    const sdk = client(fetchImpl);
    const error = await sdk.emails
      .send({ from: "hi@example.com", to: "a@example.com", subject: "hi", text: "hi" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PouchError);
    expect(error).toMatchObject({
      code: "domain_not_verified",
      status: 422,
      field: "from",
      detail: { missing_records: ["TXT"] },
    });
  });

  it("carries the request id from a response header when the server sends one", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: "invalid_key", message: "invalid" } }, 401, { "x-request-id": "req_123" }));

    const sdk = client(fetchImpl);
    await expect(sdk.emails.get("msg_x")).rejects.toMatchObject({ requestId: "req_123" });
  });

  it("leaves requestId undefined when the response carries no request id header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { code: "invalid_key", message: "invalid" } }, 401));

    const sdk = client(fetchImpl);
    try {
      await sdk.emails.get("msg_x");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PouchError);
      expect((error as PouchError).requestId).toBeUndefined();
    }
  });

  it("reads Retry-After into retryAfter on a rate-limit error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { code: "rate_limit_exceeded", message: "Rate limit exceeded for this key. Retry after 12 seconds." } },
        429,
        { "retry-after": "12" },
      ),
    );

    const sdk = client(fetchImpl);
    await expect(sdk.emails.get("msg_x")).rejects.toMatchObject({ code: "rate_limit_exceeded", retryAfter: 12 });
  });

  it("maps a non-envelope body to sdk_unparseable_response, not a real API code", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Bad Gateway", { status: 502 }));

    const sdk = client(fetchImpl);
    await expect(sdk.emails.get("msg_x")).rejects.toMatchObject({ status: 502, code: "sdk_unparseable_response" });
  });
});

describe("PouchClient header construction", () => {
  it("sends the API key as a bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "msg_1" }, 200));
    const sdk = client(fetchImpl);

    await sdk.emails.get("msg_1");

    const [, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_test_abc");
  });

  it("sets content-type only when a body is sent", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => jsonResponse({ id: "msg_1" }, 200));
    const sdk = client(fetchImpl);

    await sdk.emails.get("msg_1");
    const [, getInit] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect((getInit.headers as Record<string, string>)["content-type"]).toBeUndefined();

    await sdk.domains.create({ name: "example.com", provider_id: "acct_1" });
    const [, postInit] = fetchImpl.mock.calls[1] as [URL, RequestInit];
    expect((postInit.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("builds the request URL against the configured base URL and path", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "dom_1" }, 200));
    const sdk = client(fetchImpl);

    await sdk.domains.get("dom_1");

    const [url] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.example.test/v1/domains/dom_1");
  });

  it("reads the organization's standing from /v1/reputation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ object: "reputation", standing: "watch" }, 200));
    const sdk = client(fetchImpl);

    const reputation = await sdk.reputation.get();

    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.example.test/v1/reputation");
    expect(init.method).toBe("GET");
    expect(reputation.standing).toBe("watch");
  });

  it("omits undefined query params instead of sending them as the string 'undefined'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [], next_cursor: null }, 200));
    const sdk = client(fetchImpl);

    await sdk.domains.list();

    const [url] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.search).toBe("");
  });

  it("includes limit and cursor when given", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [], next_cursor: null }, 200));
    const sdk = client(fetchImpl);

    await sdk.domains.list({ limit: 10, cursor: "dom_9" });

    const [url] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("cursor")).toBe("dom_9");
  });

  it("invokes onRateLimit with the parsed rate-limit headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ id: "msg_1" }, 200, {
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "97",
        "x-ratelimit-reset": "1710000000",
      }),
    );
    const onRateLimit = vi.fn();
    const sdk = client(fetchImpl, { onRateLimit });

    await sdk.emails.get("msg_1");

    expect(onRateLimit).toHaveBeenCalledWith({ limit: 100, remaining: 97, reset: 1710000000 });
  });

  it("does not invoke onRateLimit when the response carries no rate-limit headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "msg_1" }, 200));
    const onRateLimit = vi.fn();
    const sdk = client(fetchImpl, { onRateLimit });

    await sdk.emails.get("msg_1");

    expect(onRateLimit).not.toHaveBeenCalled();
  });
});

describe("PouchClient idempotency key passthrough", () => {
  it("sends Idempotency-Key only when given, and not the prior one on the next send", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => jsonResponse({ id: "msg_1" }, 202));
    const sdk = client(fetchImpl);
    const message = { from: "hi@example.com", to: "a@example.com", subject: "hi", text: "hi" };

    await sdk.emails.send(message, { idempotencyKey: "a" });
    await sdk.emails.send(message, { idempotencyKey: "b" });
    await sdk.emails.send(message);

    const headers = fetchImpl.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>);
    expect(headers[0]).toHaveProperty("Idempotency-Key", "a");
    expect(headers[1]).toHaveProperty("Idempotency-Key", "b");
    expect(headers[2]).not.toHaveProperty("Idempotency-Key");
  });
});

describe("PouchClient construction", () => {
  it("requires an apiKey", () => {
    // @ts-expect-error missing required option
    expect(() => new PouchClient({})).toThrow();
  });

  it("requires a baseUrl", () => {
    // @ts-expect-error missing required option
    expect(() => new PouchClient({ apiKey: "sk_test_abc" })).toThrow("baseUrl");
  });

  it("strips a trailing slash from a custom base URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "msg_1" }, 200));
    const sdk = new PouchClient({ apiKey: "sk_test_abc", baseUrl: "https://api.example.test/", fetch: fetchImpl });

    await sdk.emails.get("msg_1");

    const [url] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.example.test/v1/emails/msg_1");
  });
});

describe("PouchClient include and fields", () => {
  it("sends them comma-separated, and the list's key filter with them", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ data: [], next_cursor: null }, 200)));
    const sdk = client(fetchImpl);

    await sdk.emails.get("msg_x", { include: ["body", "events"], fields: ["status"] });
    await sdk.emails.list({ key: "key_1", include: ["body"] });
    await sdk.inbound.get("inb_x", { fields: ["subject"] });

    const urls = fetchImpl.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls[0]!.searchParams.get("include")).toBe("body,events");
    expect(urls[0]!.searchParams.get("fields")).toBe("status");
    expect(urls[1]!.searchParams.get("key")).toBe("key_1");
    expect(urls[1]!.searchParams.get("include")).toBe("body");
    expect(urls[2]!.searchParams.has("include")).toBe(false);
    expect(urls[2]!.searchParams.get("fields")).toBe("subject");
  });

  it("sends them on every other resource read", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ data: [], next_cursor: null }, 200)));
    const sdk = client(fetchImpl);

    await sdk.domains.get("dom_x", { fields: ["name"] });
    await sdk.lists.list({ include: ["member_counts"] });
    await sdk.organization.get({ fields: ["name"] });
    await sdk.addresses.forwardTargets.get("adr_x", "fwt_x", { fields: ["email"] });

    const queries = fetchImpl.mock.calls.map(([url]) => new URL(String(url)).search);
    expect(queries).toEqual(["?fields=name", "?include=member_counts", "?fields=name", "?fields=email"]);
  });
});
