import { describe, expect, it } from "vitest";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/api/request-id";

function requestWith(id: string | undefined): Request {
  const headers = new Headers();
  if (id) headers.set(REQUEST_ID_HEADER, id);
  return new Request("http://localhost/v1/emails", { headers });
}

describe("resolveRequestId", () => {
  it("honors a well-formed inbound id", () => {
    expect(resolveRequestId(requestWith("caller-trace-abc123"))).toBe("caller-trace-abc123");
  });

  it("mints an id when none is supplied", () => {
    const id = resolveRequestId(requestWith(undefined));
    expect(id).toMatch(/^req_[a-z0-9]{24}$/);
  });

  it("mints an id when the inbound one exceeds the length bound", () => {
    const id = resolveRequestId(requestWith("a".repeat(129)));
    expect(id).toMatch(/^req_[a-z0-9]{24}$/);
  });

  it("mints an id when the inbound one carries characters outside the allowed set", () => {
    const id = resolveRequestId(requestWith("trace id/with spaces"));
    expect(id).toMatch(/^req_[a-z0-9]{24}$/);
  });

  it("mints an id when the inbound header is blank", () => {
    const id = resolveRequestId(requestWith("   "));
    expect(id).toMatch(/^req_[a-z0-9]{24}$/);
  });
});

describe("withRequestId", () => {
  it("binds the id for the handler's log lines and echoes it on the response", async () => {
    const { currentRequestId, withRequestId } = await import("@/lib/api/request-context");
    let seen: string | undefined;
    const handler = withRequestId(async () => {
      seen = currentRequestId();
      return new Response(null, { status: 204 });
    });

    const response = await handler(requestWith("caller-trace-abc123"));

    expect(seen).toBe("caller-trace-abc123");
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("caller-trace-abc123");
  });

  it("leaves a response whose headers are immutable alone", async () => {
    const { withRequestId } = await import("@/lib/api/request-context");
    const handler = withRequestId(async () => Response.redirect("http://localhost/signin", 302));

    const response = await handler(requestWith(undefined));

    expect(response.status).toBe(302);
  });
});

describe("runWithRequestId", () => {
  it("runs without binding anything when there's no id", async () => {
    const { currentRequestId, runWithRequestId } = await import("@/lib/api/request-context");
    expect(runWithRequestId(null, () => currentRequestId())).toBeUndefined();
  });
});
