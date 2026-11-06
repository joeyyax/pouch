import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { messages, providers } from "@/lib/db/schema";
import { adapterFor } from "@/lib/providers";
import { buildAdapter, capabilitiesOf } from "@/lib/providers/adapters";
import type { Adapter, OutboundMessage } from "@/lib/providers/adapters/types";
import { withFeedbackId } from "@/lib/messages/feedback-id";
import { MAX_ATTEMPTS, decideDelivery, failureMessage, retryDelayMs } from "@/lib/messages/delivery";
import { recordEvent, recordOccurrence } from "@/lib/messages/events";
import { publishMessageUpdate } from "@/lib/messages/updates";
import { assertTransition } from "@/lib/messages/lifecycle";
import type { ClaimedMessage } from "@/lib/messages/queue";
import { readBody } from "@/lib/storage/bodies";
import { applyLayoutOverrides, renderLayout } from "@/lib/domains/layout";
import { stallStateFor } from "@/lib/domains/stall";
import { rebuildLostSetup } from "@/lib/domains/rebuild";
import { holdsQueue, suspendedFailureReason, suspensionOf } from "@/lib/suspension";
import { TENANT_CHECK_TTL_SECONDS, recordProviderSendOutcome } from "@/lib/health/checks";
import { findSuppressed } from "@/lib/messages/suppression";
import { logger } from "@/lib/logger";
import { checkLinkDomains } from "@/lib/blocklists/links";
import { reportError } from "@/lib/errors/report";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker:send");

/**
 * How long a message held for a stalled domain sits before the worker looks at it again. Short
 * enough that a released hold sends promptly, long enough that a busy domain doesn't turn into a
 * tight claim/release loop while it's stalled.
 */
export const STALL_RECHECK_MS = 2 * 60 * 1000;

function adapterForMessage(claimed: ClaimedMessage): Adapter {
  // testModeDelivery tells the mock provider a test-mode key accepted this, so it should
  // never fail bounce@/defer@/slow@ at accept time — the worker's test-mode loop resolves
  // them asynchronously instead, the way a real provider's webhook would.
  if (claimed.message.testMode) return buildAdapter("mock", {}, { testModeDelivery: "true" });
  return adapterFor(claimed.provider);
}

export async function toOutbound(claimed: ClaimedMessage): Promise<OutboundMessage> {
  const { message } = claimed;
  // Test mode always sends through the mock provider (see adapterForMessage), so headers must
  // match its capabilities rather than the real provider's underlying adapter.
  const sendingModule = message.testMode ? "mock" : claimed.provider.adapter;
  if (!message.storageKey) throw new Error(`Message ${message.id} has no stored body.`);
  // bodyKey is the per-message key set at accept time. A null key means the retention sweep
  // already shredded it, so the body can't be read and the worker must back off, not send empty.
  if (!message.bodyKey) throw new Error(`Message ${message.id} has no body key.`);
  const body = await readBody(Buffer.from(message.bodyKey, "base64"), message.storageKey);
  // The frame wraps the html part only. A text part is the caller's words and stays theirs.
  const html =
    message.layout && claimed.layout && body.html
      ? renderLayout(body.html, applyLayoutOverrides(claimed.layout, message.layoutOverrides), claimed.domainName)
      : body.html;
  return {
    id: message.id,
    from: { name: message.envelope.fromName, address: message.envelope.from },
    to: message.envelope.to,
    cc: message.envelope.cc,
    bcc: message.envelope.bcc,
    replyTo: message.envelope.replyTo,
    subject: message.subject,
    html,
    text: body.text,
    headers: withFeedbackId(
      message.envelope.headers,
      claimed.domainOrganizationId,
      message.batchId ? "bulk" : "transactional",
      capabilitiesOf(sendingModule).customHeaders,
    ),
    tags: message.tags,
    attachments: body.attachments,
  };
}

/**
 * Writes to a claimed row only while the caller still holds its lock, so a worker that lost
 * the row to the stale-lock timeout can't clobber whoever reclaimed it. Reports whether its
 * write landed, so the caller can skip side effects (events, logs) that belong to the winner.
 */
async function writeIfHeld(where: SQL | undefined, values: Partial<typeof messages.$inferInsert>): Promise<boolean> {
  const updated = await db.update(messages).set(values).where(where).returning({ id: messages.id });
  return updated.length > 0;
}

/** Fails a claimed message without spending an attempt: it can't be sent, however often it's tried. */
async function failWithoutSending(claimed: ClaimedMessage, held: SQL | undefined, reason: string, why: string): Promise<void> {
  const { message } = claimed;
  const now = await dbNow();
  assertTransition(message.status, "failed");
  const wrote = await writeIfHeld(held, {
    status: "failed",
    failureReason: reason,
    lockedAt: null,
    lockedBy: null,
    updatedAt: now,
  });
  if (!wrote) return;
  await recordEvent({ organizationId: message.organizationId, messageId: message.id, status: "failed", reason });
  await publishMessageUpdate(message.organizationId, { messageId: message.id, status: "failed" });
  log.info(`${why} — failed ${message.id}`);
}

/**
 * Backs off a shared provider, which holds every tenant on it. Never shortens a longer backoff, and
 * stamps `backingOffSince` only when the provider wasn't already backing off.
 */
async function backOffSharedProvider(sharedProviderId: string, now: Date, until: Date): Promise<void> {
  const nowParam = sql`${now.toISOString()}::timestamptz`;
  const untilParam = sql`${until.toISOString()}::timestamptz`;
  await db
    .update(providers)
    .set({
      backoffUntil: sql`greatest(${providers.backoffUntil}, ${untilParam})`,
      backingOffSince: sql`case when ${providers.backoffUntil} is null or ${providers.backoffUntil} <= ${nowParam} then ${nowParam} else ${providers.backingOffSince} end`,
      updatedAt: now,
    })
    .where(eq(providers.id, sharedProviderId));
}

/** Sends one claimed message and writes the outcome. Never throws. */
export async function deliver(claimed: ClaimedMessage, workerId?: string): Promise<void> {
  const { message, provider } = claimed;
  const attempts = message.attempts + 1;
  // The service's own mail is held by the suspension of the organization whose provider carries it.
  const carrierId = claimed.domainOrganizationId;

  // A worker that lost its lock to the stale-lock timeout must not overwrite the winner.
  const held = workerId
    ? and(eq(messages.id, message.id), eq(messages.lockedBy, workerId))
    : eq(messages.id, message.id);

  const suspension = await suspensionOf(carrierId);
  if (suspension && !holdsQueue(suspension.source)) {
    await failWithoutSending(claimed, held, suspendedFailureReason(suspension), `organization ${carrierId} is suspended`);
    return;
  }

  // The stall guard (#94) holds a domain's queue by setting this on the domain row, not by
  // touching the message — so a message claimed for a domain that's since stalled goes back to
  // queued untouched: no attempt spent, no failure reason, nothing lost. It sends the moment a
  // person clears the hold.
  const stall = (await stallStateFor([message.domainId])).get(message.domainId);
  if (stall || suspension) {
    const now = await dbNow();
    const wrote = await writeIfHeld(held, {
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt: new Date(now.getTime() + STALL_RECHECK_MS),
      updatedAt: now,
    });
    if (wrote) {
      const why = stall ? `domain ${message.domainId} is stalled (${stall.reason})` : `organization ${carrierId} is suspended`;
      log.info(`${why} — leaving ${message.id} queued`);
    }
    return;
  }

  // Accept checked this too. A message held by a stall, a backoff or retries can outlive it.
  const [suppressed] = await findSuppressed(message.organizationId, message.recipients);
  if (suppressed) {
    const day = suppressed.createdAt.toISOString().slice(0, 10);
    const reason = `Recipient is suppressed: ${suppressed.reason.replace("_", " ")} on ${day}.`;
    await failWithoutSending(claimed, held, reason, `a recipient of ${message.id} was suppressed after it was accepted`);
    return;
  }

  // Recorded before the provider call so a crash mid-call leaves attempts and last_attempt_at
  // moved forward on reclaim, instead of the row looking untouched.
  try {
    // The database's clock throughout, so what this row says about "due" means the same thing
    // to the query that claims it next. See lib/db/clock.ts.
    const startedAt = await dbNow();
    const stillHeld = await writeIfHeld(held, { attempts, lastAttemptAt: startedAt, updatedAt: startedAt });
    if (!stillHeld) {
      log.warn(`lost the lock on ${message.id} before sending, leaving it to the worker that holds it`);
      return;
    }

    const outbound = await toOutbound(claimed);
    // Runs beside the send, never ahead of it, and settles within its own timeout.
    const linkListings = message.testMode ? Promise.resolve(null) : checkLinkDomains(outbound.html, claimed.domainName, startedAt);
    const receipt = await adapterForMessage(claimed).send(outbound);
    // Test mode never touches the real provider, so it has nothing to say about the provider's health.
    if (!message.testMode) {
      void recordProviderSendOutcome(provider.id, provider.adapter, receipt, provider.sharedProviderId ? TENANT_CHECK_TTL_SECONDS : undefined);
    }
    if (!receipt.successful && receipt.lostSetup) {
      await rebuildLostSetup(provider, receipt.lostSetup).catch((err: Error) => log.warn(`rebuilding setup for ${provider.id} threw: ${safeErrorMessage(err)}`));
    }
    const now = await dbNow();
    const action = decideDelivery(receipt, attempts, Math.random, now.getTime() - message.createdAt.getTime());

    if (action.kind === "sent") {
      assertTransition(message.status, "sent");
      const wrote = await writeIfHeld(held, {
        status: "sent",
        providerId: provider.id,
        providerMessageId: action.providerMessageId,
        sentAt: now,
        linkListings: await linkListings,
        lockedAt: null,
        lockedBy: null,
        failureReason: null,
        updatedAt: now,
      });
      if (wrote) {
        await recordEvent({ organizationId: message.organizationId, messageId: message.id, status: "sent" });
        await publishMessageUpdate(message.organizationId, { messageId: message.id, status: "sent" });
        log.info(`sent ${message.id} via ${provider.adapter} as ${action.providerMessageId}`);
        // A successful send proves the provider isn't degraded, whatever its last backoff said.
        // Guarded so a provider that was never backing off doesn't get a write on every send.
        const cleared = provider.sharedProviderId ? [provider.id, provider.sharedProviderId] : [provider.id];
        await db
          .update(providers)
          .set({ backingOffSince: null })
          .where(and(inArray(providers.id, cleared), isNotNull(providers.backingOffSince)));
      }
      return;
    }

    if (action.kind === "backoff") {
      const until = new Date(now.getTime() + action.backoffMs);
      if (action.accountWide && provider.sharedProviderId) {
        await backOffSharedProvider(provider.sharedProviderId, now, until);
      } else {
        // Only the first backoff of an unbroken run stamps backingOffSince — one still in
        // progress (backoffUntil still ahead of now) leaves it where it started.
        const startingNewRun = !(provider.backoffUntil && provider.backoffUntil.getTime() > now.getTime());
        await db
          .update(providers)
          .set({ backoffUntil: until, ...(startingNewRun ? { backingOffSince: now } : {}), updatedAt: now })
          .where(eq(providers.id, provider.id));
      }
      // A 429 or quota response is a backoff on the provider, never a spent attempt.
      const wrote = await writeIfHeld(held, {
        attempts: message.attempts,
        nextAttemptAt: until,
        lockedAt: null,
        lockedBy: null,
        updatedAt: now,
      });
      if (wrote) {
        // Coalesced: a message that keeps meeting a throttled provider gets one row, recounted.
        await recordOccurrence({
          organizationId: message.organizationId,
          messageId: message.id,
          kind: "backoff",
          reason: action.reason,
          detail: { until: until.toISOString(), count: 1 },
          coalesce: true,
        });
      }
      const heldProvider = action.accountWide && provider.sharedProviderId ? `shared provider ${provider.sharedProviderId}` : `provider ${provider.id}`;
      log.warn(`${heldProvider} backing off until ${until.toISOString()}: ${action.reason}`);
      return;
    }

    if (action.kind === "retry") {
      const nextAttemptAt = new Date(now.getTime() + action.retryInMs);
      const wrote = await writeIfHeld(held, {
        nextAttemptAt,
        failureReason: action.reason,
        lockedAt: null,
        lockedBy: null,
        updatedAt: now,
      });
      if (wrote) {
        await recordOccurrence({
          organizationId: message.organizationId,
          messageId: message.id,
          kind: "retry",
          reason: action.reason,
          detail: { attempt: attempts, nextAttemptAt: nextAttemptAt.toISOString() },
        });
      }
      return;
    }

    assertTransition(message.status, "failed");
    const wrote = await writeIfHeld(held, {
      status: "failed",
      failureReason: action.reason,
      lockedAt: null,
      lockedBy: null,
      updatedAt: now,
    });
    if (wrote) {
      await recordEvent({
        organizationId: message.organizationId,
        messageId: message.id,
        status: "failed",
        reason: failureMessage(action.reason),
      });
      await publishMessageUpdate(message.organizationId, { messageId: message.id, status: "failed" });
    }
  } catch (err) {
    // An unexpected throw still spends an attempt, so a broken message can't hot-loop the worker.
    // This is the code not already handling the failure — a provider's own decline goes through
    // decideDelivery above and is normal operation, not an error — so it's the one path here
    // reported to GlitchTip.
    const reason = safeErrorMessage(err);
    log.error(`delivery of ${message.id} threw: ${reason}`);
    reportError(err, {
      messageId: message.id,
      organizationId: carrierId,
      providerId: provider.id,
      providerAdapter: provider.adapter,
      requestId: message.requestId ?? undefined,
    });
    const exhausted = attempts >= MAX_ATTEMPTS;
    // deliver never throws, so a clock read that fails here falls back rather than propagating.
    const now = await dbNow().catch(() => new Date());
    const nextAttemptAt = new Date(now.getTime() + retryDelayMs(attempts));

    const wrote = await writeIfHeld(held, {
      status: exhausted ? "failed" : "queued",
      failureReason: reason,
      nextAttemptAt,
      lockedAt: null,
      lockedBy: null,
      updatedAt: now,
    }).catch(() => false);

    if (wrote && !exhausted) {
      await recordOccurrence({
        organizationId: message.organizationId,
        messageId: message.id,
        kind: "retry",
        reason,
        detail: { attempt: attempts, nextAttemptAt: nextAttemptAt.toISOString() },
      }).catch(() => "");
    }

    if (wrote && exhausted) {
      // Both guarded: this is the catch block, so anything thrown here escapes deliver() — which
      // the send loop treats as a crash and reports a second time for one incident.
      await recordEvent({
        organizationId: message.organizationId,
        messageId: message.id,
        status: "failed",
        reason,
      }).catch((err: unknown) => {
        log.warn(`couldn't record the failed event for ${message.id}: ${safeErrorMessage(err)}`);
      });
      await publishMessageUpdate(message.organizationId, { messageId: message.id, status: "failed" }).catch(
        (err: unknown) => {
          log.warn(`couldn't publish the failed update for ${message.id}: ${safeErrorMessage(err)}`);
        },
      );
    }
  }
}