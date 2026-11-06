import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type TLSSocket } from "node:tls";
import type { SMTPServer } from "smtp-server";
import { afterEach, describe, expect, it } from "vitest";
import { createImplicitTlsServer, closeSmtpServers, type SmtpListener } from "@/lib/smtp/server";
import { loadTlsConfig, watchTlsConfig } from "@/lib/smtp/tls";
import { SMTP_CERTIFICATE, SMTP_PRIVATE_KEY } from "../fixtures/smtp-certificate";
import { SMTP_CERTIFICATE_ROTATED, SMTP_PRIVATE_KEY_ROTATED } from "../fixtures/smtp-certificate-rotated";

let dir: string | null = null;
let listener: SmtpListener | null = null;
let stopWatch: (() => void) | null = null;

afterEach(async () => {
  stopWatch?.();
  stopWatch = null;
  if (listener) await closeSmtpServers([listener]);
  listener = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  delete process.env.SMTP_TLS_CERT_PATH;
  delete process.env.SMTP_TLS_KEY_PATH;
});

function listen(server: SMTPServer): Promise<SmtpListener> {
  return new Promise((resolve) => {
    const netServer = server.listen(0, () => {
      const address = netServer.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function peerFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: TLSSocket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      const fingerprint = socket.getPeerCertificate().fingerprint256;
      socket.end();
      resolve(fingerprint);
    });
    socket.on("error", reject);
  });
}

/** Waits for the listener's live certificate to change, polling instead of sleeping a fixed guess. */
async function waitForRotation(port: number, previousFingerprint: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const fingerprint = await peerFingerprint(port);
    if (fingerprint !== previousFingerprint) return fingerprint;
    if (Date.now() > deadline) throw new Error("certificate was not rotated within the timeout");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("SMTP TLS certificate rotation", () => {
  it("picks up a rotated certificate on disk without restarting the listener", async () => {
    dir = mkdtempSync(join(tmpdir(), "smtp-tls-rotation-"));
    const certPath = join(dir, "smtp.pouch.email.crt");
    const keyPath = join(dir, "smtp.pouch.email.key");
    writeFileSync(certPath, SMTP_CERTIFICATE);
    writeFileSync(keyPath, SMTP_PRIVATE_KEY);
    process.env.SMTP_TLS_CERT_PATH = certPath;
    process.env.SMTP_TLS_KEY_PATH = keyPath;

    const initial = loadTlsConfig();
    expect(initial).not.toBeNull();
    listener = await listen(createImplicitTlsServer(initial!));

    const before = await peerFingerprint(listener.port);

    stopWatch = watchTlsConfig((next) => listener!.server.updateSecureContext({ key: next.key, cert: next.cert }), 50);

    // The dumper replaces both PEMs with a rename over the existing path, same as
    // traefik-certs-dumper's --watch mode does on renewal — write elsewhere, then swap in,
    // rather than truncating the file in place.
    const nextCertPath = join(dir, "smtp.pouch.email.crt.tmp");
    const nextKeyPath = join(dir, "smtp.pouch.email.key.tmp");
    writeFileSync(nextCertPath, SMTP_CERTIFICATE_ROTATED);
    writeFileSync(nextKeyPath, SMTP_PRIVATE_KEY_ROTATED);
    renameSync(nextCertPath, certPath);
    renameSync(nextKeyPath, keyPath);

    const after = await waitForRotation(listener.port, before);
    expect(after).not.toBe(before);
  });
});
