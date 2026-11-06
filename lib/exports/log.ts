/**
 * The message log export: CSV for a spreadsheet, NDJSON for full fidelity including the
 * lifecycle events a CSV would flatten badly. Both walk the same filtered, cursor-paged set
 * of messages (lib/exports/messages-query.ts) so the two formats never drift against each
 * other or against the messages screen they're exported from.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageEvents } from "@/lib/db/schema";
import type { MessageFilters } from "@/lib/messages/filters";
import { serializeMessage } from "@/lib/messages/serialize";
import { csvRow } from "./csv";
import { iterateExportMessages } from "./messages-query";
import { EVENTS_OLDEST_FIRST } from "@/lib/messages/event-order";

const CSV_HEADER = [
  "id",
  "status",
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "tags",
  "domain",
  "test_mode",
  "provider_message_id",
  "failure_reason",
  "attempts",
  "created_at",
  "sent_at",
  "delivered_at",
];

export async function* messagesCsvLines(organizationId: string, filters: MessageFilters): AsyncGenerator<string> {
  yield csvRow(CSV_HEADER);
  for await (const { message, domainName } of iterateExportMessages(organizationId, filters)) {
    const { envelope } = message;
    yield csvRow([
      message.id,
      message.status,
      envelope.fromName ? `${envelope.fromName} <${envelope.from}>` : envelope.from,
      envelope.to.join("; "),
      envelope.cc.join("; "),
      envelope.bcc.join("; "),
      message.subject,
      message.tags.join("; "),
      domainName,
      message.testMode,
      message.providerMessageId,
      message.failureReason,
      message.attempts,
      message.createdAt.toISOString(),
      message.sentAt?.toISOString() ?? null,
      message.deliveredAt?.toISOString() ?? null,
    ]);
  }
}

/** Every occurrence for one message, oldest first — the full lifecycle, not just transitions. */
async function eventsFor(organizationId: string, messageId: string) {
  return db
    .select()
    .from(messageEvents)
    .where(and(eq(messageEvents.organizationId, organizationId), eq(messageEvents.messageId, messageId)))
    .orderBy(...EVENTS_OLDEST_FIRST);
}

export async function* messagesNdjsonLines(organizationId: string, filters: MessageFilters): AsyncGenerator<string> {
  for await (const { message } of iterateExportMessages(organizationId, filters)) {
    const events = await eventsFor(organizationId, message.id);
    const line = {
      type: "message" as const,
      ...serializeMessage(message),
      envelope: message.envelope,
      warnings: message.warnings,
      events: events.map((event) => ({
        id: event.id,
        kind: event.kind,
        status: event.status,
        reason: event.reason,
        provider_id: event.providerId,
        provider_event_id: event.providerEventId,
        detail: event.detail,
        occurred_at: event.occurredAt.toISOString(),
      })),
    };
    yield `${JSON.stringify(line)}\n`;
  }
}
