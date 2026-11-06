import "@/lib/env";
import { checkBootConfig } from "@/lib/config";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { closeDb, pingDb } from "@/lib/db";
import { onShutdown, runShutdownNow } from "@/lib/lifecycle";
import { logger } from "@/lib/logger";
import { closeRedis } from "@/lib/redis";
import { initErrorReporting, reportError, flushErrorReporting } from "@/lib/errors/report";
import { loadTlsConfig } from "@/lib/smtp/tls";
import { closeSmtpServers, startSmtpServers, type SmtpListener } from "@/lib/smtp/server";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("smtp");
const processId = `smtp-${randomUUID().slice(0, 8)}`;

let ready = false;

function startHealthServer(listeners: SmtpListener[]): void {
  const port = Number(process.env.SMTP_HEALTH_PORT ?? "3102");
  const startedAt = Date.now();
  const server = createServer((request, response) => {
    if (request.url !== "/healthz") {
      response.writeHead(404).end();
      return;
    }
    void pingDb().then((database) => {
      const healthy = ready && database;
      response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: healthy,
          process_id: processId,
          uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
          database,
          listening: listeners.map((listener) => listener.port),
        }),
      );
    });
  });

  server.listen(port, () => log.info(`health endpoint listening on :${port}/healthz`));
  onShutdown("smtp:health", () => new Promise<void>((resolve) => server.close(() => resolve())));
}

async function main(): Promise<void> {
  checkBootConfig("smtp");
  initErrorReporting(process.env.GIT_SHA);
  log.info(`${processId} starting`);

  onShutdown("smtp:db", () => closeDb());
  onShutdown("smtp:redis", () => closeRedis());

  const tls = loadTlsConfig();
  const listeners = startSmtpServers(tls);
  // smtp-server waits up to 30s for open sessions, then answers 421 and closes them.
  onShutdown("smtp:listeners", () => closeSmtpServers(listeners).then(() => undefined), { drain: true });

  startHealthServer(listeners);

  ready = true;
  log.info(`${processId} booted`);
}

async function shutdown(signal: string): Promise<void> {
  log.info(`received ${signal}, shutting down`);
  ready = false;
  await runShutdownNow(signal).catch((err) => log.warn(`shutdown error: ${safeErrorMessage(err)}`));
  setTimeout(() => process.exit(0), 100).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/** Unattended process: a crash that reports nothing is invisible. See worker/index.ts. */
async function crash(kind: string, err: unknown): Promise<void> {
  log.error(`${kind} — exiting:`, err);
  reportError(err, { workerId: processId, errorCode: kind });
  await flushErrorReporting().catch(() => {});
  process.exit(1);
}
process.on("uncaughtException", (err) => void crash("uncaughtException", err));
process.on("unhandledRejection", (err) => void crash("unhandledRejection", err));

void main();
