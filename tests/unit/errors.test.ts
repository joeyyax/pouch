import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { errorResponse } from "@/lib/api/response";

describe("error envelope", () => {
  it("nests code, message, field and detail under error", async () => {
    const response = errorResponse(
      new ApiError("recipient_suppressed", "Recipient is suppressed: hard bounce on 2026-08-14.", {
        field: "to",
        detail: { address: "ada@example.com" },
      }),
    );

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      error: {
        code: "recipient_suppressed",
        message: "Recipient is suppressed: hard bounce on 2026-08-14.",
        field: "to",
        detail: { address: "ada@example.com" },
      },
    });
  });

  it("omits field and detail when they were not given", async () => {
    const body = (await errorResponse(new ApiError("not_found", "No message with id msg_x.")).json()) as {
      error: Record<string, unknown>;
    };

    expect(Object.keys(body.error)).toEqual(["code", "message"]);
  });

  it("carries error headers onto the response", () => {
    const response = errorResponse(
      new ApiError("rate_limit_exceeded", "Rate limit exceeded for this key. Retry after 12 seconds.", {
        headers: { "Retry-After": "12" },
      }),
    );

    expect(response.headers.get("retry-after")).toBe("12");
  });

  it("turns an unexpected throw into a 503 envelope rather than leaking it", async () => {
    const response = errorResponse(new Error("connection refused to 10.0.0.1"));
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("provider_unavailable");
    expect(body.error.message).not.toContain("10.0.0.1");
  });

  it("carries the request id in the header and the envelope when given one", async () => {
    const response = errorResponse(new ApiError("not_found", "No message with id msg_x."), {}, "req_abc123");
    const body = (await response.json()) as { error: { request_id?: string } };

    expect(response.headers.get("x-request-id")).toBe("req_abc123");
    expect(body.error.request_id).toBe("req_abc123");
  });

  it("carries the request id on an unhandled-error envelope too", async () => {
    const response = errorResponse(new Error("boom"), {}, "req_abc123");
    const body = (await response.json()) as { error: { request_id?: string } };

    expect(response.headers.get("x-request-id")).toBe("req_abc123");
    expect(body.error.request_id).toBe("req_abc123");
  });

  it("omits request_id when none was given", async () => {
    const body = (await errorResponse(new ApiError("not_found", "No message with id msg_x.")).json()) as {
      error: Record<string, unknown>;
    };

    expect(Object.keys(body.error)).toEqual(["code", "message"]);
  });
});
