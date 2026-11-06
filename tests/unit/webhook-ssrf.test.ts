import { describe, expect, it, vi } from "vitest";

const lookup = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...args: unknown[]) => lookup(...args) }));

const { resolvePublicTarget, UnsafeWebhookUrlError } = await import("@/lib/webhooks/ssrf");

describe("resolvePublicTarget", () => {
  it("rejects a hostname that resolves to a private address", async () => {
    lookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    await expect(resolvePublicTarget("https://internal.example.net/hook")).rejects.toBeInstanceOf(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects loopback", async () => {
    lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(resolvePublicTarget("https://sneaky.example.net/hook")).rejects.toBeInstanceOf(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects a link-local IPv6 address", async () => {
    lookup.mockResolvedValueOnce([{ address: "fe80::1", family: 6 }]);
    await expect(resolvePublicTarget("https://linklocal.example.net/hook")).rejects.toBeInstanceOf(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects when any resolved address is private, even if another is public", async () => {
    lookup.mockResolvedValueOnce([
      { address: "203.0.113.9", family: 4 },
      { address: "192.168.1.1", family: 4 },
    ]);
    await expect(resolvePublicTarget("https://mixed.example.net/hook")).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
  });

  it("accepts a hostname that resolves to a public address over https", async () => {
    lookup.mockResolvedValueOnce([{ address: "203.0.113.9", family: 4 }]);
    const target = await resolvePublicTarget("https://public.example.net/hook?a=1");
    expect(target.address).toBe("203.0.113.9");
    expect(target.hostname).toBe("public.example.net");
    expect(target.path).toBe("/hook?a=1");
  });

  it("rejects plain http to a public address", async () => {
    lookup.mockResolvedValueOnce([{ address: "203.0.113.9", family: 4 }]);
    await expect(resolvePublicTarget("http://public.example.net/hook")).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
  });

  it("allows http to loopback outside production — the one documented exception", async () => {
    vi.stubEnv("NODE_ENV", "development");
    try {
      lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
      const target = await resolvePublicTarget("http://localhost:4600/hook");
      expect(target.address).toBe("127.0.0.1");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("still rejects http to loopback in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
      await expect(resolvePublicTarget("http://localhost:4600/hook")).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
