import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { logger } from "@/lib/logger";
import { smtpHandlers } from "./handler";
import { insecureAuthAllowed, watchTlsConfig, type SmtpTlsConfig } from "./tls";

const log = logger.child("smtp:server");

/** Idle connections and the max concurrent clients — settings, not hardcodes, per docs/decisions.md. */
function baseOptions(): SMTPServerOptions {
  return {
    ...smtpHandlers,
    // AUTH PLAIN carries the key secret in the clear unless the session is already TLS —
    // never allow it to leak on an unencrypted connection.
    authOptional: false,
    allowInsecureAuth: false,
    authMethods: ["PLAIN", "LOGIN"],
    size: Number(process.env.SMTP_MAX_MESSAGE_BYTES ?? 30 * 1024 * 1024),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS ?? 60_000),
    maxClients: Number(process.env.SMTP_MAX_CLIENTS ?? 100),
    // Without this, smtp-server greets with os.hostname() — the container id in production,
    // which doesn't resolve and reads as unfinished to a client logging the banner.
    // Unset locally and in tests, where the container id was never the point.
    name: process.env.SMTP_TLS_HOST,
    logger: false,
  };
}

/**
 * Port 587: plaintext until STARTTLS, advertised once a certificate is configured. Without one,
 * `AUTH PLAIN` never runs in the clear as a silent fallback — the only two outcomes are an
 * explicit non-production opt-in (`insecureAuthAllowed`), or every send rejected outright.
 */
export function createSubmissionServer(tls: SmtpTlsConfig | null): SMTPServer {
  if (tls) return new SMTPServer({ ...baseOptions(), secure: false, key: tls.key, cert: tls.cert });

  if (insecureAuthAllowed()) {
    log.warn("no TLS certificate configured — :587 accepts AUTH PLAIN in the clear (NODE_ENV !== \"production\" only).");
    return new SMTPServer({ ...baseOptions(), secure: false, hideSTARTTLS: true, allowInsecureAuth: true });
  }

  log.error(
    "no TLS certificate configured — :587 is starting with AUTH disabled. Every send will be rejected until " +
      "SMTP_TLS_CERT_PATH and SMTP_TLS_KEY_PATH are set.",
  );
  return new SMTPServer({ ...baseOptions(), secure: false, hideSTARTTLS: true, disabledCommands: ["AUTH"] });
}

/** Implicit TLS (465): TLS from the first byte. Opt-in, and only with a certificate. */
export function createImplicitTlsServer(tls: SmtpTlsConfig): SMTPServer {
  return new SMTPServer({ ...baseOptions(), secure: true, key: tls.key, cert: tls.cert });
}

export interface SmtpListener {
  server: SMTPServer;
  port: number;
}

/**
 * Starts 587 always. Implicit TLS starts only when `SMTP_IMPLICIT_TLS_PORT` is set and a
 * certificate is configured; production leaves it off (docs/decisions.md).
 *
 * With a certificate, also watches its files and pushes a rotated one into both listeners via
 * `updateSecureContext` — `smtp-server`'s own mechanism for changing the certificate a live
 * server presents, same one its default SNI handler builds from at construction. This is what
 * makes a Let's Encrypt renewal (`docs/engineering.md`'s SMTP TLS deploy notes) a non-event
 * instead of a certificate silently going stale until the process is restarted.
 */
export function startSmtpServers(tls: SmtpTlsConfig | null): SmtpListener[] {
  const submissionPort = Number(process.env.SMTP_SUBMISSION_PORT ?? "587");
  const listeners: SmtpListener[] = [{ server: createSubmissionServer(tls), port: submissionPort }];

  const implicitPort = process.env.SMTP_IMPLICIT_TLS_PORT;
  if (implicitPort && tls) {
    listeners.push({ server: createImplicitTlsServer(tls), port: Number(implicitPort) });
  } else if (implicitPort) {
    log.warn(`no TLS certificate configured — implicit TLS on :${implicitPort} won't start.`);
  }

  for (const listener of listeners) {
    listener.server.on("error", (err: Error & { report?: boolean }) => {
      if (err.report === false) return;
      log.error(`listener on :${listener.port} error:`, err);
    });
    listener.server.listen(listener.port, () => log.info(`listening on :${listener.port}`));
  }

  if (tls) {
    watchTlsConfig((next) => {
      for (const listener of listeners) listener.server.updateSecureContext({ key: next.key, cert: next.cert });
    });
  }

  return listeners;
}

export function closeSmtpServers(listeners: SmtpListener[]): Promise<void[]> {
  return Promise.all(listeners.map((listener) => new Promise<void>((resolve) => listener.server.close(() => resolve()))));
}
