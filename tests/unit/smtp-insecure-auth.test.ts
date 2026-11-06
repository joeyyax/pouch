import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubmissionServer } from "@/lib/smtp/server";

afterEach(() => vi.unstubAllEnvs());

/**
 * A key authenticates the whole send API, so `AUTH PLAIN` running in the clear is a
 * credential leaked on the wire, not a degraded feature. With no certificate configured,
 * :587 must never fall back to accepting it silently — see docs/decisions.md and the PR for #8.
 */
describe("createSubmissionServer without a certificate", () => {
  it("disables AUTH outright in production rather than accepting it unencrypted", () => {
    vi.stubEnv("NODE_ENV", "production");
    const server = createSubmissionServer(null);
    expect(server.options.allowInsecureAuth).not.toBe(true);
    expect(server.options.disabledCommands).toContain("AUTH");
  });

  it("allows insecure AUTH only outside production, as an explicit dev/CI affordance", () => {
    vi.stubEnv("NODE_ENV", "test");
    const server = createSubmissionServer(null);
    expect(server.options.allowInsecureAuth).toBe(true);
    expect(server.options.disabledCommands ?? []).not.toContain("AUTH");
  });
});
