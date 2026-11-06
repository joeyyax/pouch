import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { webhookAttempts, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { recordActivity, workerActor } from "@/lib/activity/record";
import { decrypt } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { sendWebhookDisabledAlert } from "@/lib/mail/alerts/webhook-disabled";
import { recordOccurrence } from "@/lib/messages/events";
import { nextAttempt } from "@/lib/webhooks/backoff";
import { postSigned } from "@/lib/webhooks/deliver";
import { claimDeliveries, type ClaimedDelivery } from "@/lib/webhooks/queue";
import { rollingPass } from "@/lib/worker/rolling";
import { reportTickFailure } from "@/lib/worker/tick-failure";
import { resolvePublicTarget, UnsafeWebhookUrlError, WebhookHostUnresolvedError } from "@/lib/webhooks/ssrf";
import { sign } from "@/lib/webhooks/sign";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker:webhooks");

/** A dead URL disables itself rather than retrying forever: this many exhausted deliveries in a
 * row for one endpoint, with no success between them. */
export const CONSECUTIVE_EXHAUSTED_LIMIT = 5;

export interface WebhookLoopOptions {
  workerId: string;
  intervalMs: number;
  batchSize: number;
}

/** A 410 means the receiver is gone for good — no point spending the backoff schedule on it. */
const STOP_STATUS = 410;

/** Delivers one claimed webhook and writes the outcome. Never throws. */
export async function deliverWebhook(claimed: ClaimedDelivery): Promise<void> {
  const { delivery, endpoint } = claimed;
  const attempts = delivery.attempts + 1;
  // The database's clock, so the next_attempt_at written below is due when the claim query says.
  const now = await dbNow();
  const body = JSON.stringify(delivery.payload);

  // Guarded on the lock this call claimed with, so a delivery reclaimed after the stale-lock
  // timeout can't have its outcome overwritten by the worker that lost it.
  const finish = async (values: Partial<typeof webhookDeliveries.$inferInsert>, attemptResult: { statusCode: number | null; error: string | null; durationMs: number }) => {
    await db.insert(webhookAttempts).values({
      id: newId("webhookAttempt"),
      organizationId: delivery.organizationId,
      deliveryId: delivery.id,
      attempt: attempts,
      statusCode: attemptResult.statusCode,
      error: attemptResult.error,
      durationMs: attemptResult.durationMs,
    });
    await db
      .update(webhookDeliveries)
      .set({ attempts, lockedAt: null, lockedBy: null, ...values })
      .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.lockedBy, delivery.lockedBy ?? "")));
  };

  try {
    const target = await resolvePublicTarget(endpoint.url);
    const timestamp = Math.floor(now.getTime() / 1000);
    const secret = decrypt(endpoint.secretEncrypted);
    const headers = {
      "Content-Type": "application/json",
      "X-Signature": sign(secret, timestamp, body),
      "X-Timestamp": String(timestamp),
      "X-Webhook-Id": delivery.id,
      "X-Webhook-Event": delivery.eventType,
    };

    // A throw here (not just a rejected connection) is still a transport failure — an IP-literal
    // host failing TLS servername validation, say — and belongs in the same retry schedule as a
    // non-2xx response, not the immediate exhaustion below reserved for a URL that's unsafe to
    // even try.
    const result = await postSigned(target, body, headers).catch((err) => ({
      statusCode: null,
      error: safeErrorMessage(err),
      durationMs: 0,
    }));
    const code = result.statusCode;
    const succeeded = code !== null && code >= 200 && code < 300;

    if (succeeded) {
      await finish({ status: "succeeded", succeededAt: now, lastStatusCode: code, lastError: null }, result);
      await db.update(webhookEndpoints).set({ lastSuccessAt: now }).where(eq(webhookEndpoints.id, endpoint.id));
      // Only a delivery that landed goes on the message. Failures are the endpoint's story,
      // and the key detail page tells it.
      if (delivery.messageId) {
        await recordOccurrence({
          organizationId: delivery.organizationId,
          messageId: delivery.messageId,
          kind: "webhook_delivered",
          detail: { eventType: delivery.eventType, url: endpoint.url, statusCode: code },
          occurredAt: now,
        }).catch((err) => log.warn(`recording the delivery on ${delivery.messageId} failed: ${safeErrorMessage(err)}`));
      }
      return;
    }

    const stop = result.statusCode === STOP_STATUS;
    const exhausted = stop || nextAttempt(attempts, now, delivery.expiresAt).exhausted;

    await finish(
      {
        status: exhausted ? "exhausted" : "pending",
        // A retried delivery keeps its next_attempt_at meaningless once exhausted; the status
        // change alone is what drops it out of the claim query.
        ...(exhausted ? {} : { nextAttemptAt: nextAttempt(attempts, now, delivery.expiresAt).nextAttemptAt }),
        lastStatusCode: result.statusCode,
        lastError: result.error ?? `HTTP ${result.statusCode}`,
      },
      result,
    );
    await db.update(webhookEndpoints).set({ lastFailureAt: now }).where(eq(webhookEndpoints.id, endpoint.id));

    if (exhausted) {
      log.warn(`delivery ${delivery.id} to ${endpoint.id} exhausted after ${attempts} attempt(s)`);
      await maybeDisableEndpoint(delivery.organizationId, endpoint.id, now);
    }
  } catch (err) {
    const message = safeErrorMessage(err);

    // A host that doesn't resolve is a transport failure — the receiver's DNS is down, not their
    // URL turned dangerous — so it retries on the normal schedule. Only a URL that policy refuses
    // to try at all (private address, plain http, malformed) exhausts on the spot.
    const transient = err instanceof WebhookHostUnresolvedError || !(err instanceof UnsafeWebhookUrlError);
    const { nextAttemptAt, exhausted } = nextAttempt(attempts, now, delivery.expiresAt);
    const stopsHere = !transient || exhausted;

    log.warn(`delivery ${delivery.id} to ${endpoint.id} failed before request: ${message}`);
    await finish(
      {
        status: stopsHere ? "exhausted" : "pending",
        ...(stopsHere ? {} : { nextAttemptAt }),
        lastStatusCode: null,
        lastError: message,
      },
      { statusCode: null, error: message, durationMs: 0 },
    );
    await db.update(webhookEndpoints).set({ lastFailureAt: now }).where(eq(webhookEndpoints.id, endpoint.id));
    if (stopsHere) await maybeDisableEndpoint(delivery.organizationId, endpoint.id, now);
  }
}

/** Disables an endpoint once its last CONSECUTIVE_EXHAUSTED_LIMIT terminal deliveries all exhausted.
 * `now` is the database's clock, the same reading the caller already took for this delivery. */
async function maybeDisableEndpoint(organizationId: string, endpointId: string, now: Date): Promise<void> {
  const recent = await db
    .select({ status: webhookDeliveries.status })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.organizationId, organizationId),
        eq(webhookDeliveries.endpointId, endpointId),
        inArray(webhookDeliveries.status, ["succeeded", "exhausted"]),
      ),
    )
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(CONSECUTIVE_EXHAUSTED_LIMIT);

  if (recent.length < CONSECUTIVE_EXHAUSTED_LIMIT) return;
  if (!recent.every((row) => row.status === "exhausted")) return;

  // Guarded on isNull(disabledAt): two deliveries can both hit this path in the same pass, and
  // only the write that actually flips the endpoint off should produce an activity row.
  const [disabled] = await db
    .update(webhookEndpoints)
    .set({ disabledAt: now })
    .where(and(eq(webhookEndpoints.id, endpointId), isNull(webhookEndpoints.disabledAt)))
    .returning();
  if (!disabled) return;

  log.warn(`disabled endpoint ${endpointId} after ${CONSECUTIVE_EXHAUSTED_LIMIT} consecutive exhausted deliveries`);
  await recordActivity({
    organizationId,
    action: "system.endpoint.auto_disabled",
    actor: workerActor("Webhook delivery"),
    appliesTo: endpointId,
    subjectLabel: disabled.url,
    metadata: { apiKeyId: disabled.apiKeyId, consecutiveFailures: CONSECUTIVE_EXHAUSTED_LIMIT },
  });

  // Pouch is up and this provider's fine — this alert earns email, not ntfy. Best-effort: a
  // notification failing here must never undo the disable it's reporting on.
  await sendWebhookDisabledAlert(disabled, CONSECUTIVE_EXHAUSTED_LIMIT).catch((err) => {
    const reason = safeErrorMessage(err);
    log.warn(`couldn't send the disabled-endpoint alert for ${endpointId}: ${reason}`);
  });
}

/** Claiming stops this long into a pass, so its heartbeat stays inside the stale window. */
const PASS_BUDGET_MS = 4_000;

/**
 * Polls for due webhook deliveries and posts them, alongside the send, verify, retention and
 * test-mode loops. Up to `batchSize` are in flight, each freed slot claiming the next.
 */
export class WebhookLoop extends IntervalLoop<number> {
  protected readonly name = "webhook";
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;

  constructor(private readonly options: WebhookLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<number> {
    const { claimed, backlog } = await rollingPass({
      limit: this.options.batchSize,
      budgetMs: PASS_BUDGET_MS,
      claim: (room) => claimDeliveries(this.options.workerId, room),
      work: deliverWebhook,
      stopped: () => this.stopped,
    });
    // Out of budget with deliveries still due: the next pass starts now, not at the next interval.
    if (backlog) setImmediate(() => void this.tick().catch((err: unknown) => reportTickFailure(log, this.name, err, this.workerId)));
    return claimed;
  }

}
