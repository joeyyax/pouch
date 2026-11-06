import { afterEach, describe, expect, it, vi } from "vitest";
import { CALLER_KEY_VAR, messageReadSnippets, sendSnippets } from "@/lib/dashboard/curl";

afterEach(() => vi.unstubAllEnvs());

describe("sendSnippets", () => {
  // The image builds with NEXT_PUBLIC_APP_URL empty, and Next inlines that empty string.
  it("falls back to APP_URL when the build-time URL is empty", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("APP_URL", "https://pouch.email/");
    expect(sendSnippets("$KEY", "example.com")[0]!.code).toContain("curl https://pouch.email/v1/emails");
  });

  it("sends through the SDK, reading a placeholder key from the environment and naming a real one", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("APP_URL", "https://pouch.email");
    const [, placeholder] = sendSnippets("$KEY", "example.com");
    expect(placeholder).toMatchObject({ id: "typescript", language: "typescript" });
    expect(placeholder!.code).toContain('import { PouchClient } from "@joeyyax/pouch";');
    expect(placeholder!.code).toContain(`apiKey: process.env.${CALLER_KEY_VAR}!`);
    expect(placeholder!.code).toContain('baseUrl: "https://pouch.email",');
    expect(placeholder!.code).toContain('from: "hi@example.com",');
    expect(sendSnippets("sk_live_abc", "example.com")[1]!.code).toContain('apiKey: "sk_live_abc"');
  });

  it("names the install's own base URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("APP_URL", "http://localhost:3100");
    expect(sendSnippets("$KEY", "example.com")[1]!.code).toContain('baseUrl: "http://localhost:3100"');
  });
});

describe("messageReadSnippets", () => {
  it("asks for the body in both languages", () => {
    const [curl, typescript] = messageReadSnippets("$KEY", "msg_1", true);
    expect(curl!.code).toContain("/v1/emails/msg_1?include=body");
    expect(typescript!.code).toContain('pouch.emails.get("msg_1", { include: ["body"] })');
  });
});
