import { afterEach, describe, expect, it, vi } from "vitest";
import { KEY_PLACEHOLDER, smtpSnippets } from "@/lib/dashboard/curl";
import { keySmtp, smtpEndpoint } from "@/lib/dashboard/smtp";

afterEach(() => vi.unstubAllEnvs());

const options = [
  { id: "dom_a", name: "a.example.com", verified: false },
  { id: "dom_b", name: "b.example.com", verified: true },
  { id: "dom_c", name: "c.example.com", verified: true },
];

describe("smtpEndpoint", () => {
  it("names SMTP_TLS_HOST and always STARTTLS in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMTP_TLS_HOST", "smtp.example.com");
    vi.stubEnv("SMTP_SUBMISSION_PORT", "");
    vi.stubEnv("SMTP_TLS_CERT_PATH", "");
    expect(smtpEndpoint()).toEqual({ host: "smtp.example.com", port: 587, tls: "starttls" });
  });

  it("has no host in production without SMTP_TLS_HOST", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMTP_TLS_HOST", "");
    expect(smtpEndpoint().host).toBeNull();
  });

  it("is localhost on the dev port without TLS in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SMTP_TLS_HOST", "");
    vi.stubEnv("SMTP_SUBMISSION_PORT", "2587");
    vi.stubEnv("SMTP_TLS_CERT_PATH", "");
    expect(smtpEndpoint()).toEqual({ host: "localhost", port: 2587, tls: "none" });
  });
});

describe("keySmtp", () => {
  it("lists only the domains a scoped key can send from, and sends from a verified one", () => {
    vi.stubEnv("SMTP_TLS_HOST", "smtp.example.com");
    const smtp = keySmtp({ id: "key_1", domainIds: ["dom_a", "dom_c"] }, KEY_PLACEHOLDER, options);
    expect(smtp.domains.map((domain) => domain.id)).toEqual(["dom_a", "dom_c"]);
    expect(smtp.everyDomain).toBe(false);
    expect(smtp.snippets?.[0]?.code).toContain("SMTP_FROM=hi@c.example.com");
  });

  it("lists every domain for a key scoped to all", () => {
    vi.stubEnv("SMTP_TLS_HOST", "smtp.example.com");
    const smtp = keySmtp({ id: "key_1", domainIds: [] }, KEY_PLACEHOLDER, options);
    expect(smtp.domains).toHaveLength(3);
    expect(smtp.everyDomain).toBe(true);
  });

  it("has no snippets without a host", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMTP_TLS_HOST", "");
    expect(keySmtp({ id: "key_1", domainIds: [] }, KEY_PLACEHOLDER, options).snippets).toBeNull();
  });
});

describe("smtpSnippets", () => {
  const endpoint = { host: "smtp.example.com", port: 587, tls: "starttls" as const };

  it("writes the generic block, EMAIL_URL and Grafana's variables", () => {
    const [generic, url, grafana] = smtpSnippets(endpoint, "key_1", "sk_live_abc", "hi@example.com");
    expect(generic!.code).toBe(
      "SMTP_HOST=smtp.example.com\nSMTP_PORT=587\nSMTP_USER=key_1\nSMTP_PASSWORD=sk_live_abc\nSMTP_FROM=hi@example.com",
    );
    expect(url!.code).toBe("EMAIL_URL=smtp+tls://key_1:sk_live_abc@smtp.example.com:587");
    expect(grafana!.code).toContain("GF_SMTP_HOST=smtp.example.com:587");
    expect(grafana!.code).toContain("GF_SMTP_FROM_ADDRESS=hi@example.com");
    expect(grafana!.code).toContain("GF_SMTP_STARTTLS_POLICY=MandatoryStartTLS");
  });

  it("encodes a secret in EMAIL_URL and leaves the placeholder alone", () => {
    expect(smtpSnippets(endpoint, "key_1", "a/b:c", "hi@example.com")[1]!.code).toContain("key_1:a%2Fb%3Ac@");
    expect(smtpSnippets(endpoint, "key_1", KEY_PLACEHOLDER, "hi@example.com")[1]!.code).toContain("key_1:$KEY@");
  });

  it("drops STARTTLS without TLS", () => {
    const [, url, grafana] = smtpSnippets({ ...endpoint, tls: "none" }, "key_1", "sk", "hi@example.com");
    expect(url!.code).toMatch(/^EMAIL_URL=smtp:\/\//);
    expect(grafana!.code).toContain("GF_SMTP_STARTTLS_POLICY=NoStartTLS");
  });
});
