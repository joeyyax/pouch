import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, methodPolicy, readJson } from "@/lib/api/response";

function streamedRequest(chunkBytes: number, chunkCount: number, onPull: () => void): Request {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close();
        return;
      }
      sent += 1;
      onPull();
      controller.enqueue(new Uint8Array(chunkBytes));
    },
  });

  return new Request("http://localhost/v1/emails", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // undici requires this for a streamed request body; it isn't in the DOM RequestInit type.
    duplex: "half",
    body: stream,
  } as RequestInit);
}

describe("readJson", () => {
  it("stops reading once the running total crosses the limit, rather than buffering the rest", async () => {
    let pulls = 0;
    const chunkBytes = Math.ceil(MAX_BODY_BYTES / 4);
    const request = streamedRequest(chunkBytes, 10, () => {
      pulls += 1;
    });

    await expect(readJson(request)).rejects.toMatchObject({ code: "attachment_too_large" });
    expect(pulls).toBeLessThan(10);
  });

  it("still parses a normal body", async () => {
    const request = new Request("http://localhost/v1/emails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    await expect(readJson(request)).resolves.toEqual({ hello: "world" });
  });

  it("rejects malformed JSON", async () => {
    const request = new Request("http://localhost/v1/emails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    await expect(readJson(request)).rejects.toMatchObject({ code: "invalid_json" });
  });
});

describe("methodPolicy", () => {
  const { rejected, options } = methodPolicy("GET", "DELETE");

  it("answers an unsupported verb with the error envelope and an Allow header", async () => {
    const response = await rejected(new Request("http://localhost/v1/domains/dom_1", { method: "PATCH" }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, DELETE, OPTIONS");
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "method_not_allowed", message: "PATCH isn't allowed on this route. Use GET or DELETE." },
    });
  });

  it("answers OPTIONS with the verbs the route serves, not the ones it rejects", async () => {
    const response = await options(new Request("http://localhost/v1/domains/dom_1", { method: "OPTIONS" }));

    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("GET, HEAD, DELETE, OPTIONS");
  });

  it("sets X-Request-Id on a rejected response, honoring an inbound id", async () => {
    const response = await rejected(
      new Request("http://localhost/v1/domains/dom_1", { method: "PATCH", headers: { "x-request-id": "caller-id" } }),
    );

    expect(response.headers.get("x-request-id")).toBe("caller-id");
    await expect(response.json()).resolves.toMatchObject({ error: { request_id: "caller-id" } });
  });

  it("sets X-Request-Id on an OPTIONS response", async () => {
    const response = await options(new Request("http://localhost/v1/domains/dom_1", { method: "OPTIONS" }));

    expect(response.headers.get("x-request-id")).toMatch(/^req_[a-z0-9]{24}$/);
  });
});
