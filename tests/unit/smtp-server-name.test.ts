import { afterEach, describe, expect, it } from "vitest";
import { createSubmissionServer, createImplicitTlsServer } from "@/lib/smtp/server";
import { SMTP_CERTIFICATE, SMTP_PRIVATE_KEY } from "../fixtures/smtp-certificate";

afterEach(() => {
  delete process.env.SMTP_TLS_HOST;
});

describe("SMTP banner name", () => {
  it("uses SMTP_TLS_HOST for both listeners' greeting instead of the container hostname", () => {
    process.env.SMTP_TLS_HOST = "smtp.pouch.email";
    const tls = { key: Buffer.from(SMTP_PRIVATE_KEY), cert: Buffer.from(SMTP_CERTIFICATE) };

    const submission = createSubmissionServer(tls);
    const implicit = createImplicitTlsServer(tls);

    expect((submission as unknown as { options: { name?: string } }).options.name).toBe("smtp.pouch.email");
    expect((implicit as unknown as { options: { name?: string } }).options.name).toBe("smtp.pouch.email");
  });

  it("falls back to smtp-server's own default (os.hostname()) when SMTP_TLS_HOST is unset", () => {
    delete process.env.SMTP_TLS_HOST;
    const tls = { key: Buffer.from(SMTP_PRIVATE_KEY), cert: Buffer.from(SMTP_CERTIFICATE) };

    const submission = createSubmissionServer(tls);

    expect((submission as unknown as { options: { name?: string } }).options.name).toBeUndefined();
  });
});
