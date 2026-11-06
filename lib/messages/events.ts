import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { disableTargetsForMessage } from "@/lib/addresses/forward-disable";
import { db, type Executor } from "@/lib/db";
import { messageEvents, messages } from "@/lib/db/schema";
import type { MessageRow, MessageStatus } from "@/lib/db/schema";
import type { WebhookEventType } from "@/lib/db/schema";
import { normalizeAddress } from "@/lib/addresses";
import { newId } from "@/lib/ids";
import { logger } from "@/lib/logger";
import type { NormalizedEvent } from "@/lib/providers/adapters/types";
import { enqueueWebhooks } from "@/lib/webhooks/dispatch";
import { canTransition } from "./lifecycle";
import { suppress } from "./suppression";
import { touchRecipientHistory, type HistoryEventStatus } from "./history";
import { publishMessageUpdate } from "./updates";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("events");

export interface RecordEventInput {
  /** Null on the service's own mail. */
  organizationId: string | null;
  messageId: string;
  status: MessageStatus;
  reason?: string | null;
  bounceType?: string | null;
  detail?: Record<string, unknown>;
  occurredAt?: Date;
  /** The provider whose callback carried the event. Required alongside `providerEventId`. */
  providerId?: string | null;
  providerEventId?: string | null;
}

/** The structured facts each occurrence carries. The timeline words them; the row stays data. */
export interface OccurrenceDetail {
  retry: { attempt: number; nextAttemptAt: string };
  backoff: { until: string; count: number };
  suppressed: { address: string; suppressionReason: "hard_bounce" | "complaint" };
  body_shredded: { retentionDays: number };
  webhook_delivered: { eventType: WebhookEventType; url: string; statusCode: number };
  abandoned: { thresholdMs: number };
}

export type OccurrenceKind = keyof OccurrenceDetail;

export interface RecordOccurrenceInput<K extends OccurrenceKind> {
  /** Null on the service's own mail. */
  organizationId: string | null;
  messageId: string;
  kind: K;
  detail: OccurrenceDetail[K];
  /** The provider's reason, verbatim, where there is one. */
  reason?: string | null;
  occurredAt?: Date;
  /** Folds into the newest row when that row is the same kind, instead of adding another. */
  coalesce?: boolean;
}

/**
 * Writes one occurrence: something that happened to a message without moving its status.
 * Returns the row's id, which is the folded-into row when coalescing.
 */
export async function recordOccurrence<K extends OccurrenceKind>(
  input: RecordOccurrenceInput<K>,
  executor: Executor = db,
): Promise<string> {
  // The database's clock, without a round trip to read it: every ordering this column feeds
  // compares it against another row's, so it can't come from the app.
  const occurredAt = input.occurredAt ?? sql`now()`;

  if (input.coalesce) {
    const [newest] = await executor
      .select({ id: messageEvents.id, kind: messageEvents.kind, detail: messageEvents.detail })
      .from(messageEvents)
      .where(eq(messageEvents.messageId, input.messageId))
      .orderBy(desc(messageEvents.occurredAt), desc(messageEvents.id))
      .limit(1);

    if (newest && newest.kind === input.kind) {
      const count = typeof newest.detail.count === "number" ? newest.detail.count : 1;
      await executor
        .update(messageEvents)
        .set({ reason: input.reason ?? null, detail: { ...input.detail, count: count + 1 }, occurredAt })
        .where(eq(messageEvents.id, newest.id));
      return newest.id;
    }
  }

  const id = newId("event");
  await executor.insert(messageEvents).values({
    id,
    organizationId: input.organizationId,
    messageId: input.messageId,
    kind: input.kind,
    status: null,
    reason: input.reason ?? null,
    detail: input.detail,
    occurredAt,
  });
  return id;
}

/** Writes one lifecycle transition row. Returns null when the provider already sent this event. */
export async function recordEvent(input: RecordEventInput, executor: Executor = db): Promise<string | null> {
  const id = newId("event");
  const inserted = await executor
    .insert(messageEvents)
    .values({
      id,
      organizationId: input.organizationId,
      messageId: input.messageId,
      status: input.status,
      reason: input.reason ?? null,
      bounceType: input.bounceType ?? null,
      detail: input.detail ?? {},
      occurredAt: input.occurredAt ?? sql`now()`,
      providerId: input.providerId ?? null,
      providerEventId: input.providerEventId ?? null,
    })
    .onConflictDoNothing({
      target: [messageEvents.providerId, messageEvents.providerEventId],
      where: isNotNull(messageEvents.providerEventId),
    })
    .returning({ id: messageEvents.id });
  return inserted[0]?.id ?? null;
}

/**
 * Attaches a provider's send event to the row the worker already wrote, instead of adding a second
 * one. Both rows are true — the service handed the message over, and the provider confirmed it —
 * but they're one lifecycle transition, and a mail log that shows `sent` twice invites the reader
 * to wonder whether the message went out twice.
 *
 * The worker's row is the one that stays, because the service owns the truth: a provider whose
 * callback never arrives must not leave a delivered message with no `sent` on its timeline. What
 * the provider's event adds is its own id, which is what makes a retried webhook dedupe from here
 * on, its authoritative timestamp, and whatever detail it carried.
 *
 * Only the newest unclaimed row is taken. A `deferred → sent` message has a self-raised row per
 * attempt, and those are separate transitions, not copies of one.
 */
async function adoptSelfRaisedSent(
  provider: EventSource,
  messageId: string,
  event: NormalizedEvent,
  executor: Executor,
): Promise<string | null> {
  if (event.status !== "sent" || !event.providerEventId) return null;

  const [existing] = await executor
    .select({ id: messageEvents.id })
    .from(messageEvents)
    .where(
      and(
        eq(messageEvents.messageId, messageId),
        eq(messageEvents.status, "sent"),
        isNull(messageEvents.providerEventId),
      ),
    )
    .orderBy(desc(messageEvents.occurredAt), desc(messageEvents.id))
    .limit(1);

  if (!existing) return null;

  const [adopted] = await executor
    .update(messageEvents)
    .set({
      providerId: provider.id,
      providerEventId: event.providerEventId,
      occurredAt: event.occurredAt,
      reason: event.reason,
      detail: event.detail,
    })
    // Guarded on still being unclaimed, so two copies of one webhook can't both adopt it.
    .where(and(eq(messageEvents.id, existing.id), isNull(messageEvents.providerEventId)))
    .returning({ id: messageEvents.id });

  return adopted?.id ?? null;
}

/** The provider a callback authenticated as. Provider ids are only unique within one. */
export interface EventSource {
  id: string;
  /** Null for a test-mode resolution of the service's own mail. */
  organizationId: string | null;
}

export type ApplyOutcome = "recorded" | "duplicate" | "unknown_message";

export interface AppliedEvent {
  outcome: ApplyOutcome;
  messageId: string | null;
  /** Whether the message row moved to the event's status. */
  statusChanged: boolean;
}

/** Which suppression a terminal event earns, if any. */
const SUPPRESSION_REASON: Partial<Record<NormalizedEvent["status"], "hard_bounce" | "complaint">> = {
  bounced: "hard_bounce",
  complained: "complaint",
};

/** Which events the recipient-history rollup cares about. See lib/messages/history.ts. */
const HISTORY_STATUS: Partial<Record<NormalizedEvent["status"], HistoryEventStatus>> = {
  delivered: "delivered",
  bounced: "bounced",
  complained: "complained",
  deferred: "deferred",
};

/** The three events this increment can emit. See docs/api/conventions.md, "Outbound webhooks". */
const WEBHOOK_EVENT_FOR: Partial<Record<MessageStatus, WebhookEventType>> = {
  delivered: "email.delivered",
  bounced: "email.bounced",
  complained: "email.complained",
};

/** Column writes that come with a status, beyond the status itself. */
function columnsFor(status: MessageStatus, event: NormalizedEvent): Partial<typeof messages.$inferInsert> {
  if (status === "sent") return { sentAt: event.occurredAt, failureReason: null };
  if (status === "delivered") return { deliveredAt: event.occurredAt, failureReason: null };
  return { failureReason: event.reason };
}

/** What an applied event still owes its watchers once the transaction commits. */
interface AppliedInTx extends AppliedEvent {
  eventId: string | null;
  event: NormalizedEvent;
  /** The message row as this event left it, which the webhook reports. */
  snapshot: MessageRow | null;
}

/**
 * Applies one provider event to the message it names. Every event is recorded; the status moves
 * only when the lifecycle allows it, so an out-of-order or replayed event never throws.
 *
 * Both ids are resolved against the provider the callback authenticated as. Mailpace numbers
 * messages and events per server, so two providers of one adapter in one organization hand out
 * the same ids, and an event scoped only to the organization would land on the wrong message.
 *
 * The three writes share one transaction. The event row is what makes a retry a duplicate, so
 * it must not survive a failed suppression: the provider's retry would then dedupe on it and the
 * address would never be suppressed.
 */
export async function applyEvent(provider: EventSource, event: NormalizedEvent): Promise<AppliedEvent> {
  const [applied] = await applyEvents(provider, [event]);
  return applied!;
}

/**
 * Applies one callback's events in one transaction, so a failure part-way rolls back the whole
 * batch and the provider's retry applies each event once.
 */
export async function applyEvents(provider: EventSource, events: NormalizedEvent[]): Promise<AppliedEvent[]> {
  if (events.length === 0) return [];

  const applied = await db.transaction(async (tx) => {
    const results: AppliedInTx[] = [];
    for (const event of events) results.push(await applyInTx(provider, event, tx));
    return results;
  });

  // After the transaction: a watcher must never be told about a row that then rolled back.
  for (const result of applied) await announce(result);
  return applied.map(({ outcome, messageId, statusChanged }) => ({ outcome, messageId, statusChanged }));
}

async function applyInTx(provider: EventSource, event: NormalizedEvent, tx: Executor): Promise<AppliedInTx> {
  // Locked so a concurrent event can't move the row between this read and the commit.
  const [message] = await tx
    .select()
    .from(messages)
    .where(
      and(
        // The service's own mail goes out through the provider of the organization holding its domain.
        provider.organizationId === null
          ? isNull(messages.organizationId)
          : or(eq(messages.organizationId, provider.organizationId), isNull(messages.organizationId)),
        eq(messages.providerId, provider.id),
        eq(messages.providerMessageId, event.providerMessageId),
      ),
    )
    .limit(1)
    .for("update");

  if (!message) {
    log.warn(`event for unknown provider message id ${event.providerMessageId} on provider ${provider.id}`);
    return { outcome: "unknown_message", messageId: null, statusChanged: false, eventId: null, event, snapshot: null };
  }

  const adopted = await adoptSelfRaisedSent(provider, message.id, event, tx);
  if (adopted) {
    return { outcome: "recorded", messageId: message.id, statusChanged: false, eventId: adopted, event, snapshot: message };
  }

  const organizationId = message.organizationId;
  const eventId = await recordEvent(
    {
      organizationId,
      messageId: message.id,
      status: event.status,
      reason: event.reason,
      bounceType: event.bounceType ?? null,
      // A provider that names no address says so on the row, rather than leaving the gap
      // silent — see recipientsNamed.
      detail:
        event.recipients.length > 0
          ? { ...event.detail, recipients: event.recipients }
          : { ...event.detail, recipientsNamed: false },
      occurredAt: event.occurredAt,
      providerId: provider.id,
      providerEventId: event.providerEventId,
    },
    tx,
  );
  if (!eventId) {
    return { outcome: "duplicate", messageId: message.id, statusChanged: false, eventId: null, event, snapshot: null };
  }

  const moved = await moveStatus(message, event, tx);
  await applySuppression(message, event, tx);
  await disableTargetsForMessage(tx, message.id, event.status);

  const historyStatus = HISTORY_STATUS[event.status];
  // Recipient history is an organization's view of its own recipients.
  if (historyStatus && organizationId !== null) {
    await touchRecipientHistory(organizationId, recipientsNamed(event), historyStatus, event.occurredAt, tx);
  }

  return { outcome: "recorded", messageId: message.id, statusChanged: moved !== null, eventId, event, snapshot: moved ?? message };
}

async function announce(applied: AppliedInTx): Promise<void> {
  if (applied.outcome !== "recorded" || !applied.snapshot) return;
  const { event, snapshot } = applied;
  const organizationId = snapshot.organizationId;
  // The service's own mail has no organization to tell, by update or by webhook.
  if (organizationId === null) return;
  await publishMessageUpdate(organizationId, { messageId: snapshot.id, status: event.status });

  const webhookEventType = WEBHOOK_EVENT_FOR[event.status];
  if (!webhookEventType || !applied.eventId) return;
  await enqueueWebhooks(organizationId, {
    eventId: applied.eventId,
    eventType: webhookEventType,
    occurredAt: event.occurredAt,
    message: snapshot,
  }).catch((err) => log.warn(`enqueueWebhooks failed for ${snapshot.id}: ${safeErrorMessage(err)}`));
}

/** Returns the moved row, or null when the status stayed. */
async function moveStatus(message: MessageRow, event: NormalizedEvent, executor: Executor): Promise<MessageRow | null> {
  if (!canTransition(message.status, event.status)) return null;
  const updated = await executor
    .update(messages)
    .set({
      status: event.status,
      ...columnsFor(event.status, event),
      updatedAt: sql`now()`,
    })
    // Guarded on the status we read, so two events racing each other can't both write.
    .where(and(eq(messages.id, message.id), eq(messages.status, message.status)))
    .returning();
  return updated[0] ?? null;
}

/**
 * The addresses the event actually names. Empty when the provider named none — applying to
 * every recipient of the message would be a guess, and a guess that suppresses real addresses
 * and writes permanent recipient-history counts is worse than an honest gap. Suppression and
 * recipient_history both skip an event with nothing named; `applyEvent` notes the gap on the
 * event row instead of leaving it silent.
 */
function recipientsNamed(event: NormalizedEvent): string[] {
  return event.recipients;
}

async function applySuppression(message: MessageRow, event: NormalizedEvent, executor: Executor): Promise<void> {
  const reason = SUPPRESSION_REASON[event.status];
  if (!reason) return;
  const addresses = recipientsNamed(event);
  for (const address of addresses) {
    const added = await suppress(
      {
        organizationId: message.organizationId,
        address,
        reason,
        detail: event.reason,
        bounceType: reason === "hard_bounce" ? (event.bounceType ?? null) : null,
        sourceMessageId: message.id,
      },
      executor,
    );
    // Only the bounce that actually suppressed the address says so. An address already on the
    // list is not news about this message.
    if (!added) continue;
    await recordOccurrence(
      {
        organizationId: message.organizationId,
        messageId: message.id,
        kind: "suppressed",
        detail: { address: normalizeAddress(address), suppressionReason: reason },
      },
      executor,
    );
  }
}
