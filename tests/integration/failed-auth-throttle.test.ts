import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/v1/emails/route";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { resetDatabase, seedFixture } from "./fixtures";

interface ErrorBody {
  error: { code: string; message: string };
}

const valid = { from: "Ada <ada@example.com>", to: "person@example.net", subject: "Hello", html: "<p>Hi</p>" };

function post(secret: string | null, address: string): Request {
  return new Request("http://localhost/v1/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": address,
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(valid),
  });
}

async function failTimes(count: number, address: string): Promise<void> {
  for (let i = 0; i < count; i++) await POST(post("sk_live_notarealkey", address));
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  process.env.FAILED_AUTH_RATE_LIMIT = "3";
});
afterEach(() => {
  delete process.env.FAILED_AUTH_RATE_LIMIT;
});

describe("failed authentication throttle", () => {
  it("answers 401 up to the limit, then 429", async () => {
    await failTimes(4, "203.0.113.1");

    const response = await POST(post("sk_live_notarealkey", "203.0.113.1"));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(429);
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(body.error.message).toMatch(/this address/);
    expect(response.headers.get("retry-after")).toBeTruthy();
  });

  it("counts each address separately", async () => {
    await failTimes(4, "203.0.113.1");

    expect((await POST(post("sk_live_notarealkey", "203.0.113.2"))).status).toBe(401);
  });

  it("never counts a request that authenticates", async () => {
    const fixture = await seedFixture();

    for (let i = 0; i < 10; i++) {
      expect((await POST(post(fixture.secret, "203.0.113.3"))).status).toBe(202);
    }
  });

  it("holds the door shut against a valid key from an address that spent its failures", async () => {
    const fixture = await seedFixture();
    await failTimes(4, "203.0.113.4");

    expect((await POST(post(fixture.secret, "203.0.113.4"))).status).toBe(429);
  });
});
