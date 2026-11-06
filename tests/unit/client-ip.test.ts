import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientIp, clientIpBucket } from "@/lib/api/client-ip";

function request(headers: Record<string, string>): Request {
  return new Request("https://pouch.email/v1/emails", { headers });
}

describe("clientIp", () => {
  it("takes the last x-forwarded-for hop, the one the proxy appended", () => {
    expect(clientIp(request({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(request({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("ignores a spoofed header the caller sent ahead of the real hop", () => {
    expect(clientIp(request({ "x-forwarded-for": "9.9.9.9, 9.9.9.9, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip, then to a shared bucket", () => {
    expect(clientIp(request({ "x-real-ip": "203.0.113.5" }))).toBe("203.0.113.5");
    expect(clientIp(request({ "x-forwarded-for": " , " , "x-real-ip": "203.0.113.5" }))).toBe("203.0.113.5");
    expect(clientIp(request({}))).toBe("unknown");
  });
});

describe("clientIpBucket", () => {
  const original = process.env.BETTER_AUTH_SECRET;
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-secret-value";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = original;
  });

  it("never contains the address", () => {
    for (const ip of ["203.0.113.9", "2001:db8::1", "unknown"]) {
      const bucket = clientIpBucket(request({ "x-forwarded-for": ip }));
      expect(bucket).not.toContain(ip);
      expect(bucket).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });

  it("maps one address to one bucket, and another address to another", () => {
    const first = clientIpBucket(request({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }));
    expect(clientIpBucket(request({ "x-real-ip": "203.0.113.9" }))).toBe(first);
    expect(clientIpBucket(request({ "x-forwarded-for": "203.0.113.10" }))).not.toBe(first);
  });

  it("changes with the secret", () => {
    const bucket = clientIpBucket(request({ "x-forwarded-for": "203.0.113.9" }));
    process.env.BETTER_AUTH_SECRET = "a-different-secret";
    expect(clientIpBucket(request({ "x-forwarded-for": "203.0.113.9" }))).not.toBe(bucket);
  });
});
