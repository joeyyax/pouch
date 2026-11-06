import { describe, expect, it } from "vitest";
import * as catchAll from "@/app/api/[...path]/route";
import * as domainDetail from "@/app/api/v1/domains/[id]/route";
import * as emails from "@/app/api/v1/emails/route";

interface ErrorBody {
  error: { code: string; message: string };
}

const routes = [
  { path: "/v1/emails", adapter: emails, allow: "POST, GET, HEAD, OPTIONS", rejects: ["PUT", "PATCH", "DELETE"] },
  { path: "/v1/domains/dom_1", adapter: domainDetail, allow: "GET, HEAD, PATCH, DELETE, OPTIONS", rejects: ["POST", "PUT"] },
] as const;

describe("unsupported verbs on /v1 routes", () => {
  for (const route of routes) {
    for (const method of route.rejects) {
      it(`answers ${method} ${route.path} with the envelope`, async () => {
        const handlers = route.adapter as unknown as Record<string, (request: Request) => Promise<Response>>;
        const handler = handlers[method];
        if (!handler) throw new Error(`${route.path} exports no ${method} handler`);

        const response = await handler(new Request(`http://localhost${route.path}`, { method }));
        const body = (await response.json()) as ErrorBody;

        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe(route.allow);
        expect(body.error.code).toBe("method_not_allowed");
        expect(response.headers.get("x-request-id")).toMatch(/^req_[a-z0-9]{24}$/);
      });
    }

    it(`answers OPTIONS ${route.path} with the verbs it serves`, async () => {
      const response = await route.adapter.OPTIONS(new Request(`http://localhost${route.path}`, { method: "OPTIONS" }));

      expect(response.status).toBe(204);
      expect(response.headers.get("allow")).toBe(route.allow);
      expect(response.headers.get("x-request-id")).toMatch(/^req_[a-z0-9]{24}$/);
    });
  }
});

describe("unmatched paths under /api", () => {
  it("answers with not_found in the envelope, naming the method and path", async () => {
    const response = await catchAll.GET(new Request("http://localhost/v1/nope"));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toBe("No route matches GET /v1/nope.");
    expect(response.headers.get("x-request-id")).toMatch(/^req_[a-z0-9]{24}$/);
  });

  it("honors an inbound X-Request-Id on an unmatched path", async () => {
    const response = await catchAll.GET(
      new Request("http://localhost/v1/nope", { headers: { "x-request-id": "caller-trace-1" } }),
    );
    const body = (await response.json()) as { error: { request_id?: string } };

    expect(response.headers.get("x-request-id")).toBe("caller-trace-1");
    expect(body.error.request_id).toBe("caller-trace-1");
  });

  it("answers every verb, not only the ones a route would serve", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      const response = await catchAll[method](new Request("http://localhost/v1/nope", { method }));
      expect(response.status).toBe(404);
    }
  });
});
