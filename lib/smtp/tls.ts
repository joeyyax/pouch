import { readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { createSecureContext } from "node:tls";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("smtp:tls");

export interface SmtpTlsConfig {
  key: Buffer;
  cert: Buffer;
}

/**
 * Loads the certificate STARTTLS (587) and opt-in implicit TLS (465) both use. `SMTP_TLS_KEY_PATH`
 * and `SMTP_TLS_CERT_PATH` name files on disk — the same pair, since 587 and 465 are the same
 * identity offered two ways. Unset in a deployment means no TLS: 465 doesn't come up even when
 * enabled, and 587's behavior depends on `insecureAuthAllowed` — see `createSubmissionServer` in
 * `lib/smtp/server.ts`.
 *
 * Paths set but missing on disk (the dumper sidecar hasn't written them yet — see
 * docker-compose.traefik.yml's `mail-certs`) is treated the same as unset rather than
 * crashing the process: degraded-without-TLS is the same recoverable state either way, and a
 * boot loop teaches the operator nothing readFileSync's own ENOENT didn't already say.
 *
 * A file that exists but can't be read (permissions — `traefik-certs-dumper` writes the key
 * `0600`, root-owned) or isn't valid PEM degrades the same way: log at error level naming the
 * path and reason, return null. `smtp-server` would otherwise throw straight out of its
 * constructor on a malformed cert, so PEM validity is checked here via `createSecureContext`
 * before anything is handed back.
 */
export function loadTlsConfig(): SmtpTlsConfig | null {
  const keyPath = process.env.SMTP_TLS_KEY_PATH;
  const certPath = process.env.SMTP_TLS_CERT_PATH;
  if (!keyPath || !certPath) return null;

  let key: Buffer;
  let cert: Buffer;
  try {
    key = readFileSync(keyPath);
    cert = readFileSync(certPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      log.warn(`SMTP_TLS_KEY_PATH/SMTP_TLS_CERT_PATH set but not on disk yet (${keyPath}, ${certPath}) — starting without TLS.`);
      return null;
    }
    log.error(`couldn't read certificate (${keyPath}, ${certPath}): ${safeErrorMessage(err)} — starting without TLS.`);
    return null;
  }

  try {
    createSecureContext({ key, cert });
  } catch (err) {
    log.error(`certificate at (${keyPath}, ${certPath}) isn't valid PEM: ${safeErrorMessage(err)} — starting without TLS.`);
    return null;
  }

  return { key, cert };
}

/**
 * Whether `AUTH PLAIN` may run in the clear when no certificate is configured. Same gate as
 * the dev sign-in bypass (`lib/dev/seed-accounts.ts`'s `devSignInEnabled`) rather than a
 * second pattern for the same kind of decision — an explicit opt-in is deliberately not
 * offered, since the failure mode this guards is a key disclosed on the wire, not a feature
 * someone would reasonably want on in production.
 */
export function insecureAuthAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Watches the certificate and key files for changes and calls `onRotate` with the reloaded
 * pair each time they do. Let's Encrypt renews at 30 days; `traefik-certs-dumper` rewrites
 * the PEMs on disk when it does, and without this the SMTP process would keep serving the
 * certificate it started with until something restarts it — a working deploy that silently
 * breaks a month later.
 *
 * `fs.watch` targets a directory rather than the files themselves: the dumper (like most
 * tools that rewrite config atomically) writes to a temp file and renames it over the
 * target, which changes the file's inode. A watch on the old inode goes silent after the
 * first rotation. Watching the containing directory and filtering events down to the two
 * basenames survives the rename.
 *
 * Returns a no-op when no paths are configured, and a function that stops watching.
 */
export function watchTlsConfig(onRotate: (tls: SmtpTlsConfig) => void, debounceMs = 2000): () => void {
  const keyPath = process.env.SMTP_TLS_KEY_PATH;
  const certPath = process.env.SMTP_TLS_CERT_PATH;
  if (!keyPath || !certPath) return () => {};

  const targets = new Set([basename(keyPath), basename(certPath)]);
  const dirs = new Set([dirname(keyPath), dirname(certPath)]);

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const reload = () => {
    if (debounce) clearTimeout(debounce);
    // The dumper writes the key and cert as two separate renames — debounce so both land
    // before reloading, rather than briefly pairing a new cert with the old key.
    debounce = setTimeout(() => {
      debounce = null;
      const tls = loadTlsConfig();
      if (tls) {
        log.info("certificate changed on disk — rotating without a restart.");
        onRotate(tls);
      }
    }, debounceMs);
  };

  const watchers = Array.from(dirs, (dir) => {
    try {
      return watch(dir, (_event, filename) => {
        if (filename && targets.has(filename)) reload();
      });
    } catch (err) {
      log.warn(`couldn't watch ${dir} for certificate rotation:`, err);
      return null;
    }
  }).filter((watcher) => watcher !== null);

  return () => {
    if (debounce) clearTimeout(debounce);
    for (const watcher of watchers) watcher.close();
  };
}
