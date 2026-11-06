import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSmtpServers, startSmtpServers, type SmtpListener } from "@/lib/smtp/server";
import { SMTP_CERTIFICATE, SMTP_PRIVATE_KEY } from "../fixtures/smtp-certificate";

const tls = { key: Buffer.from(SMTP_PRIVATE_KEY), cert: Buffer.from(SMTP_CERTIFICATE) };
const saved = { ...process.env };
let listeners: SmtpListener[] = [];

beforeEach(() => {
  process.env.SMTP_SUBMISSION_PORT = "0";
  delete process.env.SMTP_IMPLICIT_TLS_PORT;
  delete process.env.SMTP_TLS_CERT_PATH;
  delete process.env.SMTP_TLS_KEY_PATH;
});

afterEach(async () => {
  await closeSmtpServers(listeners);
  listeners = [];
  process.env = { ...saved };
});

function secureFlags(): boolean[] {
  return listeners.map((listener) => Boolean((listener.server as unknown as { options: { secure?: boolean } }).options.secure));
}

describe("implicit TLS listener", () => {
  it("stays off with a certificate when SMTP_IMPLICIT_TLS_PORT is unset", () => {
    listeners = startSmtpServers(tls);
    expect(secureFlags()).toEqual([false]);
  });

  it("stays off when SMTP_IMPLICIT_TLS_PORT is empty", () => {
    process.env.SMTP_IMPLICIT_TLS_PORT = "";
    listeners = startSmtpServers(tls);
    expect(secureFlags()).toEqual([false]);
  });

  it("starts when SMTP_IMPLICIT_TLS_PORT is set and a certificate is configured", () => {
    process.env.SMTP_IMPLICIT_TLS_PORT = "0";
    listeners = startSmtpServers(tls);
    expect(secureFlags()).toEqual([false, true]);
  });

  it("stays off without a certificate even when enabled", () => {
    process.env.SMTP_IMPLICIT_TLS_PORT = "0";
    listeners = startSmtpServers(null);
    expect(secureFlags()).toEqual([false]);
  });
});
