import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTlsConfig, watchTlsConfig } from "@/lib/smtp/tls";
import { SMTP_CERTIFICATE, SMTP_PRIVATE_KEY } from "../fixtures/smtp-certificate";
import { SMTP_CERTIFICATE_ROTATED, SMTP_PRIVATE_KEY_ROTATED } from "../fixtures/smtp-certificate-rotated";

// Root reads a mode 000 file, as in the Docker build gate.
const isRoot = process.getuid?.() === 0;

let dir: string | null = null;
let stopWatch: (() => void) | null = null;

afterEach(() => {
  stopWatch?.();
  stopWatch = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  delete process.env.SMTP_TLS_CERT_PATH;
  delete process.env.SMTP_TLS_KEY_PATH;
});

describe("loadTlsConfig degrades instead of throwing", () => {
  it.skipIf(isRoot)("returns null for an unreadable key file (permission denied)", () => {
    dir = mkdtempSync(join(tmpdir(), "smtp-tls-load-"));
    const certPath = join(dir, "certificate.crt");
    const keyPath = join(dir, "privatekey.key");
    writeFileSync(certPath, SMTP_CERTIFICATE);
    writeFileSync(keyPath, SMTP_PRIVATE_KEY);
    chmodSync(keyPath, 0o000);
    process.env.SMTP_TLS_CERT_PATH = certPath;
    process.env.SMTP_TLS_KEY_PATH = keyPath;

    expect(() => loadTlsConfig()).not.toThrow();
    expect(loadTlsConfig()).toBeNull();

    // Restore so the temp dir can be cleaned up.
    chmodSync(keyPath, 0o600);
  });

  it.each([
    ["a malformed (not valid PEM) certificate", "not a certificate", SMTP_PRIVATE_KEY],
    ["a half-written (truncated) key file", SMTP_CERTIFICATE, SMTP_PRIVATE_KEY.slice(0, 40)],
  ])("returns null for %s", (_name, cert, key) => {
    dir = mkdtempSync(join(tmpdir(), "smtp-tls-load-"));
    const certPath = join(dir, "certificate.crt");
    const keyPath = join(dir, "privatekey.key");
    writeFileSync(certPath, cert);
    writeFileSync(keyPath, key);
    process.env.SMTP_TLS_CERT_PATH = certPath;
    process.env.SMTP_TLS_KEY_PATH = keyPath;

    expect(() => loadTlsConfig()).not.toThrow();
    expect(loadTlsConfig()).toBeNull();
  });
});

describe("watchTlsConfig on rotation to a broken file", () => {
  it.skipIf(isRoot)("keeps the previously loaded certificate when a rotation writes an unreadable key", async () => {
    dir = mkdtempSync(join(tmpdir(), "smtp-tls-watch-"));
    const certPath = join(dir, "certificate.crt");
    const keyPath = join(dir, "privatekey.key");
    writeFileSync(certPath, SMTP_CERTIFICATE);
    writeFileSync(keyPath, SMTP_PRIVATE_KEY);
    process.env.SMTP_TLS_CERT_PATH = certPath;
    process.env.SMTP_TLS_KEY_PATH = keyPath;

    const onRotate = vi.fn();
    stopWatch = watchTlsConfig(onRotate, 50);

    // Simulate the dumper landing a rotation whose key can't be read — same shape as
    // production's EACCES, atomic rename over the watched path.
    const nextCertPath = join(dir, "certificate.crt.tmp");
    const nextKeyPath = join(dir, "privatekey.key.tmp");
    writeFileSync(nextCertPath, SMTP_CERTIFICATE_ROTATED);
    writeFileSync(nextKeyPath, SMTP_PRIVATE_KEY_ROTATED, { mode: 0o000 });
    renameSync(nextCertPath, certPath);
    renameSync(nextKeyPath, keyPath);

    // watchTlsConfig debounces past the fs.watch event before reloading — give it time
    // to fire, then confirm it never called back with a broken pair.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(onRotate).not.toHaveBeenCalled();

    // loadTlsConfig() directly still reflects the broken file on disk — proves the earlier
    // good pair was never overwritten by watchTlsConfig, not merely that reload didn't fire.
    expect(loadTlsConfig()).toBeNull();

    chmodSync(keyPath, 0o600);
  }, 10_000);
});
