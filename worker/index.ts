import "@/lib/env";
import { checkBootConfig, workerSetting } from "@/lib/config";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { closeDb, pingDb } from "@/lib/db";
import { onShutdown, runShutdownNow } from "@/lib/lifecycle";
import { logger } from "@/lib/logger";
import { queueChannel, releaseStaleLocks } from "@/lib/messages/queue";
import { releaseStaleWebhookLocks } from "@/lib/webhooks/queue";
import { closeRedis, redis } from "@/lib/redis";
import { HEARTBEAT_TTL_SECONDS, recordHeartbeat } from "@/lib/health";
import { closeStorage } from "@/lib/storage";
import { initErrorReporting, reportError, flushErrorReporting } from "@/lib/errors/report";
import { SendLoop } from "./loop";
import { VerifyLoop } from "./verify";
import { RetentionLoop } from "./retention";
import { AbandonLoop } from "./abandon";
import { ExportLoop } from "./exports";
import { TestModeLoop } from "./test-mode";
import { WebhookLoop } from "./webhooks";
import { InboundRetentionLoop } from "./inbound-retention";
import { AddressExpiryLoop } from "./address-expiry";
import { ProviderHealthLoop } from "./health-check";
import { StallGuardLoop } from "./stall-guard";
import { DigestLoop } from "./digest";
import { ListConfirmLoop } from "./list-confirm";
import { ForwardLoop } from "./forward";
import { BlocklistLoop } from "./blocklists";
import { DomainStatsLoop } from "./domain-stats";
import { ActivityRetentionLoop } from "./activity-retention";
import { HealthWatchLoop } from "./health-watch";
import { awaitBoot, beginShutdown, getBootError, isReady, markBooted } from "./boot";
import { reportTickFailure } from "@/lib/worker/tick-failure";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker");
const workerId = `worker-${randomUUID().slice(0, 8)}`;

function startHealthServer(): void {
  const port = workerSetting("WORKER_HEALTH_PORT");
  const startedAt = Date.now();
  const server = createServer((request, response) => {
    if (request.url !== "/healthz") {
      response.writeHead(404).end();
      return;
    }
    void pingDb().then((database) => {
      const ready = isReady() && database;
      response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: ready,
          worker_id: workerId,
          uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
          database,
          boot_error: getBootError() !== null,
        }),
      );
    });
  });

  server.listen(port, () => log.info(`health endpoint listening on :${port}/healthz`));
  onShutdown("worker:health", () => new Promise<void>((resolve) => server.close(() => resolve())));
}

/** Reports liveness on a third of the key's lifetime, so one missed beat isn't an outage. */
function startHeartbeat(): void {
  const every = (HEARTBEAT_TTL_SECONDS / 3) * 1000;
  void recordHeartbeat(workerId);
  const timer = setInterval(() => void recordHeartbeat(workerId), every);
  timer.unref();
  onShutdown("worker:heartbeat", async () => clearInterval(timer));
}

function startQueueSubscriber(loop: SendLoop): void {
  const url = process.env.REDIS_URL;
  if (!url) return;
  const client = redis()?.duplicate();
  if (!client) return;

  void client.subscribe(queueChannel()).catch((err) => log.warn(`subscribe failed: ${safeErrorMessage(err)}`));
  client.on("message", () => void loop.tick().catch((err: unknown) => reportTickFailure(log, "send", err, workerId)));
  onShutdown("worker:subscriber", async () => {
    await client.quit().catch(() => client.disconnect());
  });
}

async function main(): Promise<void> {
  checkBootConfig("worker");
  initErrorReporting(process.env.GIT_SHA);
  log.info(`${workerId} starting`);
  startHealthServer();

  const loop = new SendLoop({
    workerId,
    maxConcurrency: workerSetting("WORKER_CONCURRENCY"),
    pollIntervalMs: workerSetting("WORKER_POLL_INTERVAL_MS"),
  });

  const verifyLoop = new VerifyLoop({
    workerId,
    intervalMs: workerSetting("WORKER_VERIFY_INTERVAL_MS"),
    batchSize: workerSetting("WORKER_VERIFY_BATCH"),
    recheckAfterMs: workerSetting("WORKER_VERIFY_RECHECK_MS"),
    slowRecheckAfterMs: workerSetting("WORKER_VERIFY_SLOW_RECHECK_MS"),
    pendingExpiresAfterMs: workerSetting("WORKER_VERIFY_PENDING_EXPIRES_MS"),
    verifiedRecheckAfterMs: workerSetting("WORKER_VERIFY_VERIFIED_RECHECK_MS"),
  });

  // Every loop registers as a drain, so all of them stop claiming at once and finish before these close.
  onShutdown("worker:db", () => closeDb());
  onShutdown("worker:redis", () => closeRedis());
  onShutdown("worker:storage", () => closeStorage());

  // The app's migrations may still be running, so a failed releaseStaleLocks is retried
  // with backoff until it lands; health keeps reporting 503 in the meantime.
  if (!(await awaitBoot(releaseStaleLocks))) return;
  if (!(await awaitBoot(releaseStaleWebhookLocks))) return;
  startQueueSubscriber(loop);
  startHeartbeat();
  loop.start();
  onShutdown("worker:loop", () => loop.stop(), { drain: true });
  verifyLoop.start();
  onShutdown("worker:verify", () => verifyLoop.stop(), { drain: true });

  const retentionLoop = new RetentionLoop({
    workerId,
    intervalMs: workerSetting("WORKER_RETENTION_INTERVAL_MS"),
    batchSize: workerSetting("WORKER_RETENTION_BATCH"),
  });
  retentionLoop.start();
  onShutdown("worker:retention", () => retentionLoop.stop(), { drain: true });

  const abandonLoop = new AbandonLoop({
    workerId,
    intervalMs: workerSetting("WORKER_ABANDON_INTERVAL_MS"),
    batchSize: workerSetting("WORKER_ABANDON_BATCH"),
  });
  abandonLoop.start();
  onShutdown("worker:abandon", () => abandonLoop.stop(), { drain: true });

  const exportLoop = new ExportLoop({
    workerId,
    intervalMs: workerSetting("WORKER_EXPORT_INTERVAL_MS"),
    batchSize: workerSetting("WORKER_EXPORT_BATCH"),
    expireBatchSize: workerSetting("WORKER_EXPORT_EXPIRE_BATCH"),
  });
  exportLoop.start();
  onShutdown("worker:exports", () => exportLoop.stop(), { drain: true });

  const testModeLoop = new TestModeLoop({
    workerId,
    intervalMs: workerSetting("WORKER_TEST_MODE_INTERVAL_MS"),
    batchSize: workerSetting("WORKER_TEST_MODE_BATCH"),
    delayMs: workerSetting("WORKER_TEST_MODE_DELAY_MS"),
  });
  testModeLoop.start();
  onShutdown("worker:test-mode", () => testModeLoop.stop(), { drain: true });

  const webhookLoop = new WebhookLoop({
    workerId,
    intervalMs: workerSetting("WORKER_WEBHOOK_INTERVAL_MS"),
    batchSize: workerSetting("WORKER_WEBHOOK_BATCH"),
  });
  webhookLoop.start();
  onShutdown("worker:webhooks", () => webhookLoop.stop(), { drain: true });

  const inboundRetentionLoop = new InboundRetentionLoop({
    workerId,
    intervalMs: workerSetting("WORKER_INBOUND_RETENTION_INTERVAL_MS"),
    batchSize: workerSetting("WORKER_INBOUND_RETENTION_BATCH"),
  });
  inboundRetentionLoop.start();
  onShutdown("worker:inbound-retention", () => inboundRetentionLoop.stop(), { drain: true });

  const addressExpiryLoop = new AddressExpiryLoop({
    workerId,
    intervalMs: workerSetting("WORKER_ADDRESS_EXPIRY_INTERVAL_MS"),
    batchSize: workerSetting("WORKER_ADDRESS_EXPIRY_BATCH"),
  });
  addressExpiryLoop.start();
  onShutdown("worker:address-expiry", () => addressExpiryLoop.stop(), { drain: true });

  const forwardLoop = new ForwardLoop({
    workerId,
    intervalMs: workerSetting("WORKER_FORWARD_INTERVAL_MS"),
    batchSize: workerSetting("WORKER_FORWARD_BATCH"),
  });
  forwardLoop.start();
  onShutdown("worker:forward", () => forwardLoop.stop(), { drain: true });

  const providerHealthLoop = new ProviderHealthLoop({
    workerId,
    intervalMs: workerSetting("WORKER_HEALTH_CHECK_INTERVAL_MS"),
  });
  providerHealthLoop.start();
  onShutdown("worker:provider-health", () => providerHealthLoop.stop(), { drain: true });

  const stallGuardLoop = new StallGuardLoop({
    workerId,
    intervalMs: workerSetting("WORKER_STALL_GUARD_INTERVAL_MS"),
    batchSize: workerSetting("WORKER_STALL_GUARD_BATCH"),
    recheckAfterMs: workerSetting("WORKER_STALL_GUARD_RECHECK_MS"),
  });
  stallGuardLoop.start();
  onShutdown("worker:stall-guard", () => stallGuardLoop.stop(), { drain: true });

  const digestLoop = new DigestLoop({
    workerId,
    intervalMs: workerSetting("WORKER_DIGEST_INTERVAL_MS"),
  });
  digestLoop.start();
  onShutdown("worker:digest", () => digestLoop.stop(), { drain: true });

  const listConfirmLoop = new ListConfirmLoop({
    workerId,
    intervalMs: workerSetting("WORKER_LIST_CONFIRM_INTERVAL_MS"),
    batchSize: workerSetting("WORKER_LIST_CONFIRM_BATCH"),
  });
  listConfirmLoop.start();
  onShutdown("worker:list-confirm", () => listConfirmLoop.stop(), { drain: true });

  const blocklistLoop = new BlocklistLoop({
    workerId,
    intervalMs: workerSetting("WORKER_BLOCKLIST_INTERVAL_MS"),
    batchSize: workerSetting("WORKER_BLOCKLIST_BATCH"),
  });
  blocklistLoop.start();
  onShutdown("worker:blocklists", () => blocklistLoop.stop(), { drain: true });

  const domainStatsLoop = new DomainStatsLoop({
    workerId,
    intervalMs: workerSetting("WORKER_DOMAIN_STATS_INTERVAL_MS"),
  });
  domainStatsLoop.start();
  onShutdown("worker:domain-stats", () => domainStatsLoop.stop(), { drain: true });

  const activityRetentionLoop = new ActivityRetentionLoop({
    workerId,
    intervalMs: workerSetting("WORKER_ACTIVITY_RETENTION_INTERVAL_MS"),
    batchSize: workerSetting("WORKER_ACTIVITY_RETENTION_BATCH"),
  });
  activityRetentionLoop.start();
  onShutdown("worker:activity-retention", () => activityRetentionLoop.stop(), { drain: true });

  const healthWatchLoop = new HealthWatchLoop({
    workerId,
    intervalMs: workerSetting("WORKER_HEALTH_WATCH_INTERVAL_MS"),
  });
  healthWatchLoop.start();
  onShutdown("worker:health-watch", () => healthWatchLoop.stop(), { drain: true });

  markBooted();
  log.info(`${workerId} booted`);
}

async function shutdown(signal: string): Promise<void> {
  log.info(`received ${signal}, shutting down`);
  beginShutdown();
  await runShutdownNow(signal).catch((err) => log.warn(`shutdown error: ${safeErrorMessage(err)}`));
  setTimeout(() => process.exit(0), 100).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/**
 * The worker runs unattended, so a crash that reports nothing is invisible. Both paths report
 * and flush before exiting — a queued event that never leaves the process is the same as not
 * reporting at all.
 */
async function crash(kind: string, err: unknown): Promise<void> {
  log.error(`${kind} — exiting:`, err);
  reportError(err, { workerId, errorCode: kind });
  await flushErrorReporting().catch(() => {});
  process.exit(1);
}
process.on("uncaughtException", (err) => void crash("uncaughtException", err));
process.on("unhandledRejection", (err) => void crash("unhandledRejection", err));

void main();
