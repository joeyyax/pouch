import { afterEach, describe, expect, it, vi } from "vitest";
import { awsRequestHandler, fetchWithTimeout } from "@/lib/fetch-timeout";
import { SEND_TIMEOUT_MS } from "@/lib/providers/adapters/ses";
import { STORAGE_TIMEOUT_MS } from "@/lib/storage";
import { LOCK_TIMEOUT_MS } from "@/lib/messages/queue";

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aborts a request that outlives the deadline, naming what hung", async () => {
    // A host that accepts the connection and then says nothing — the shape that hangs a worker
    // loop forever, because Node's fetch has no default timeout.
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
      });
    });

    await expect(fetchWithTimeout("https://example.invalid/x", {}, 20, "Cloudflare /zones")).rejects.toThrow(
      "Cloudflare /zones timed out after 20ms.",
    );
  });

  it("passes the response through and clears the timer when the call finishes in time", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));

      const { response, text } = await fetchWithTimeout("https://example.invalid/x", {}, 50_000, "ntfy");

      expect(response.status).toBe(200);
      // Read inside the deadline, not left for the caller to read outside it.
      expect(text).toBe("ok");
      // A timer left armed would hold the event loop open for the full deadline after every call.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards the caller's init, so headers and method survive the wrapper", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchWithTimeout("https://example.invalid/x", { method: "POST", headers: { "x-test": "1" } }, 1_000, "test");

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-test"]).toBe("1");
    expect(init.signal).toBeDefined();
  });
});

describe("outbound deadlines", () => {
  it("every provider and storage timeout finishes inside the worker's lock timeout", () => {
    // A request that outlives the lock lets a second worker reclaim the row while the first is
    // still sending, which is how one accepted message becomes two delivered ones.
    for (const timeout of [SEND_TIMEOUT_MS, STORAGE_TIMEOUT_MS]) {
      expect(timeout).toBeLessThan(LOCK_TIMEOUT_MS);
    }
  });

  it("gives an AWS client both a connection and a request deadline", () => {
    const config = awsRequestHandler(STORAGE_TIMEOUT_MS);

    expect(config.requestHandler.requestTimeout).toBe(STORAGE_TIMEOUT_MS);
    // Without a connection timeout a blackholed TCP handshake still hangs indefinitely.
    expect(config.requestHandler.connectionTimeout).toBeGreaterThan(0);
  });
});
