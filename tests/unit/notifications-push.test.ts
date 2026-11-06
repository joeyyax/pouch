import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushConfigured, sendPushAlert } from "@/lib/notifications/push/push";

const ORIGINAL = { ...process.env };

function restoreEnv(): void {
  for (const key of ["NTFY_URL", "NTFY_TOPIC", "NTFY_TOKEN"]) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
}

describe("sendPushAlert", () => {
  beforeEach(() => {
    delete process.env.NTFY_URL;
    delete process.env.NTFY_TOPIC;
    delete process.env.NTFY_TOKEN;
  });
  afterEach(() => {
    restoreEnv();
    vi.unstubAllGlobals();
  });

  it("skips without throwing when NTFY_TOPIC isn't set — no push path configured yet", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await sendPushAlert({ title: "Domain stalled: example.com", message: "Bounce rate is 10.00%, above our 2.50% action point." });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pushConfigured()).toBe(false);
  });

  it("posts the JSON publish shape ntfy expects, to the configured topic", async () => {
    process.env.NTFY_TOPIC = "pouch-ops";
    process.env.NTFY_URL = "https://ntfy.example.internal";
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await sendPushAlert({
      title: "Domain stalled: example.com",
      message: "Bounce rate is 10.00%, above our 2.50% action point.",
      tags: ["warning"],
      priority: 4,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.example.internal");
    expect(JSON.parse(init.body as string)).toEqual({
      topic: "pouch-ops",
      title: "Domain stalled: example.com",
      message: "Bounce rate is 10.00%, above our 2.50% action point.",
      tags: ["warning"],
      priority: 4,
    });
  });

  it("sends a bearer token when NTFY_TOKEN is set, and none when it isn't", async () => {
    process.env.NTFY_TOPIC = "pouch-ops";
    process.env.NTFY_TOKEN = "tk_test_secret";
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await sendPushAlert({ title: "t", message: "m" });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tk_test_secret");
  });

  it("throws on a non-2xx response so the caller's .catch() can log it", async () => {
    process.env.NTFY_TOPIC = "pouch-ops";
    const fetchSpy = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(sendPushAlert({ title: "t", message: "m" })).rejects.toThrow(/500/);
  });
});
