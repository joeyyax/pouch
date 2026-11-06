import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "@sentry/core";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { CLIENT_ERROR_RATE_LIMIT, MAX_CLIENT_ERROR_BYTES, ingestClientError } from "@/lib/errors/client-ingest";
import { initErrorReporting, resetErrorReportingForTests } from "@/lib/errors/report";

const RECIPIENT = "victim@example.com";
const SECRET_QUERY = "token=abc123secret";

let envelopes: Envelope[];

function arm(): void {
  process.env.GLITCHTIP_DSN = "https://test@errors.invalid/1";
  initErrorReporting("test-sha", {
    transport: () => ({
      send: async (envelope: Envelope) => {
        envelopes.push(envelope);
        return {};
      },
      flush: async () => true,
    }),
  });
}

async function flush(): Promise<string> {
  const { flushErrorReporting } = await import("@/lib/errors/report");
  await flushErrorReporting();
  return envelopes.map((envelope) => JSON.stringify(envelope)).join("\n");
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://pouch.email/client-errors", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-value";
  envelopes = [];
  resetErrorReportingForTests();
  resetRateLimitMemory();
});

afterEach(() => {
  delete process.env.GLITCHTIP_DSN;
  resetErrorReportingForTests();
});

describe("the client error route, with a DSN", () => {
  beforeEach(arm);

  it("sends the route, the release and a digest, and nothing else", async () => {
    const response = await ingestClientError(post({ route: "/domains/dom_1", digest: "1234567890" }));
    const wire = await flush();

    expect(response.status).toBe(204);
    expect(wire).toContain("/domains/dom_1");
    expect(wire).toContain("1234567890");
    expect(wire).toContain("test-sha");
    expect(wire).not.toContain('"request"');
    expect(wire).not.toContain('"user"');
  });

  it("refuses a field outside the schema and sends nothing", async () => {
    const response = await ingestClientError(post({ route: "/domains", message: "boom", body: RECIPIENT, headers: { a: "b" } }));

    expect(response.status).toBe(422);
    expect(await flush()).toBe("");
  });

  it("refuses a route that carries a query string or fragment", async () => {
    for (const route of [`/reset-password?${SECRET_QUERY}`, `/accept#${SECRET_QUERY}`]) {
      expect((await ingestClientError(post({ route, message: "boom" }))).status).toBe(422);
    }
    expect(await flush()).toBe("");
  });

  it("scrubs an address out of a message before it leaves", async () => {
    const response = await ingestClientError(post({ route: "/messages", message: `Cannot read ${RECIPIENT} of undefined` }));
    const wire = await flush();

    expect(response.status).toBe(204);
    expect(envelopes.length).toBeGreaterThan(0);
    expect(wire).toContain("Client render error");
    expect(wire).not.toContain(RECIPIENT);
  });

  it("limits a flood from one address and leaves another alone", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < CLIENT_ERROR_RATE_LIMIT + 3; i++) {
      statuses.push((await ingestClientError(post({ route: "/domains", digest: `d${i}` }))).status);
    }

    expect(statuses.slice(0, CLIENT_ERROR_RATE_LIMIT).every((code) => code === 204)).toBe(true);
    expect(statuses.slice(CLIENT_ERROR_RATE_LIMIT)).toEqual([429, 429, 429]);

    const other = await ingestClientError(post({ route: "/domains", digest: "other" }, { "x-forwarded-for": "198.51.100.7" }));
    expect(other.status).toBe(204);
  });

  it("refuses a body over the cap, declared or streamed, and sends nothing", async () => {
    const big = JSON.stringify({ route: "/domains", message: "x".repeat(MAX_CLIENT_ERROR_BYTES) });

    const declared = await ingestClientError(post(big, { "content-length": String(big.length) }));
    expect(declared.status).toBe(413);

    // No Content-Length: the stream is what gets counted.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const streamed = new Request("https://pouch.email/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(streamed.headers.get("content-length")).toBeNull();
    expect((await ingestClientError(streamed)).status).toBe(413);

    expect(await flush()).toBe("");
  });

  it("refuses a body that isn't JSON content", async () => {
    const response = await ingestClientError(post({ route: "/domains", digest: "abc" }, { "content-type": "text/plain" }));

    expect(response.status).toBe(415);
    expect(await flush()).toBe("");
  });
});

describe("the client error route, with no DSN", () => {
  it("answers 204, counts nothing and sends nothing", async () => {
    let sent = 0;
    initErrorReporting(undefined, {
      transport: () => ({
        send: async () => {
          sent += 1;
          return {};
        },
        flush: async () => true,
      }),
    });

    for (let i = 0; i < CLIENT_ERROR_RATE_LIMIT + 3; i++) {
      expect((await ingestClientError(post({ route: "/domains", message: `boom ${RECIPIENT}` }))).status).toBe(204);
    }
    await flush();

    expect(sent).toBe(0);
  });
});

describe("the armed flag", () => {
  it("is shared by a second copy of the reporter, as Next's separate bundles load one", async () => {
    const { vi } = await import("vitest");
    process.env.GLITCHTIP_DSN = "https://test@errors.invalid/1";
    const first = await import("@/lib/errors/report");
    vi.resetModules();
    const second = await import("@/lib/errors/report");
    expect(second).not.toBe(first);

    first.initErrorReporting("test-sha", { transport: () => ({ send: async () => ({}), flush: async () => true }) });

    expect(second.isErrorReportingArmed()).toBe(true);
  });
});
