import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { recipientHistory } from "@/lib/db/schema";
import type { MessageWarning, RecipientHistoryRow } from "@/lib/db/schema";
import { normalizeAddress } from "@/lib/addresses";

/**
 * A warning hints, it doesn't refuse — see docs/decisions.md, "The queue pauses, it doesn't
 * refuse at the door." Same instinct: a message stays accepted regardless of what fires here.
 *
 * These are our own starting points, not a provider's line — nobody has set them from real
 * volume yet. HISTORY_BOUNCE_COUNT is the number of bounces, nothing delivered since, that
 * earns a warning; recoveredSince already drops the noise of a bounce that later delivered.
 */
export const HISTORY_BOUNCE_COUNT = 1;
export const HISTORY_DEFERRAL_COUNT = 3;

/** Creates the row on first send to an address. Leaves an existing row untouched. */
export async function touchFirstSeen(organizationId: string, addresses: string[], executor: Executor = db): Promise<void> {
  const normalized = [...new Set(addresses.map(normalizeAddress))];
  if (normalized.length === 0) return;
  await executor
    .insert(recipientHistory)
    .values(normalized.map((address) => ({ organizationId, address })))
    .onConflictDoNothing();
}

export type HistoryEventStatus = "delivered" | "bounced" | "complained" | "deferred";

/**
 * Updates the rollup for one event, on every address it names. `occurredAt` is the event's
 * own timestamp — the provider's, for a webhook — never the app's clock: this only stores and
 * later compares event-supplied instants against each other, not against a due-now query.
 *
 * Call once per event, only after the event itself was recorded as new (not a duplicate) —
 * a retried webhook applying the same event twice would double the counts otherwise.
 */
export async function touchRecipientHistory(
  organizationId: string,
  addresses: string[],
  status: HistoryEventStatus,
  occurredAt: Date,
  executor: Executor = db,
): Promise<void> {
  const normalized = [...new Set(addresses.map(normalizeAddress))];
  if (normalized.length === 0) return;

  const rows = normalized.map((address) => ({
    organizationId,
    address,
    lastDeliveredAt: status === "delivered" ? occurredAt : null,
    lastBouncedAt: status === "bounced" ? occurredAt : null,
    bounceCount: status === "bounced" ? 1 : 0,
    lastComplainedAt: status === "complained" ? occurredAt : null,
    complaintCount: status === "complained" ? 1 : 0,
    lastDeferredAt: status === "deferred" ? occurredAt : null,
    deferredCount: status === "deferred" ? 1 : 0,
  }));

  const set: Record<string, SQL> = { updatedAt: sql`now()` };
  if (status === "delivered") {
    set.lastDeliveredAt = sql`greatest(${recipientHistory.lastDeliveredAt}, excluded.last_delivered_at)`;
    // deferredCount counts deferrals since the last delivery, not for all time — a delivery
    // this late or later than the newest counted deferral clears the run it closed out.
    set.deferredCount = sql`case
      when ${recipientHistory.lastDeferredAt} is null or excluded.last_delivered_at >= ${recipientHistory.lastDeferredAt}
      then 0
      else ${recipientHistory.deferredCount}
    end`;
  } else if (status === "bounced") {
    set.lastBouncedAt = sql`greatest(${recipientHistory.lastBouncedAt}, excluded.last_bounced_at)`;
    set.bounceCount = sql`${recipientHistory.bounceCount} + 1`;
  } else if (status === "complained") {
    set.lastComplainedAt = sql`greatest(${recipientHistory.lastComplainedAt}, excluded.last_complained_at)`;
    set.complaintCount = sql`${recipientHistory.complaintCount} + 1`;
  } else {
    set.lastDeferredAt = sql`greatest(${recipientHistory.lastDeferredAt}, excluded.last_deferred_at)`;
    set.deferredCount = sql`${recipientHistory.deferredCount} + 1`;
  }

  await executor
    .insert(recipientHistory)
    .values(rows)
    .onConflictDoUpdate({ target: [recipientHistory.organizationId, recipientHistory.address], set });
}

/** The rollup rows for a set of addresses, this organization's only. */
export async function historyFor(organizationId: string, addresses: string[]): Promise<RecipientHistoryRow[]> {
  const normalized = [...new Set(addresses.map(normalizeAddress))];
  if (normalized.length === 0) return [];
  return db
    .select()
    .from(recipientHistory)
    .where(and(eq(recipientHistory.organizationId, organizationId), inArray(recipientHistory.address, normalized)));
}

/** A later delivery than the bad event means the address recovered — nothing worth flagging. */
function recoveredSince(lastDeliveredAt: Date | null, badEventAt: Date): boolean {
  return lastDeliveredAt !== null && lastDeliveredAt > badEventAt;
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function times(count: number): string {
  return count === 1 ? "time" : "times";
}

/**
 * One address's rollup, turned into a warning or nothing. Complaint first: it's the worse
 * signal, same order as `lib/domains/guard.ts`'s stall check.
 */
export function evaluateHistory(row: RecipientHistoryRow): MessageWarning | null {
  if (row.lastComplainedAt && !recoveredSince(row.lastDeliveredAt, row.lastComplainedAt)) {
    return {
      code: "previously_complained",
      address: row.address,
      message: `Recipient complained about a previous message on ${day(row.lastComplainedAt)}.`,
      detail: { complaint_count: row.complaintCount, last_complained_at: row.lastComplainedAt.toISOString() },
    };
  }

  if (row.bounceCount >= HISTORY_BOUNCE_COUNT && row.lastBouncedAt && !recoveredSince(row.lastDeliveredAt, row.lastBouncedAt)) {
    return {
      code: "previously_bounced",
      address: row.address,
      message: `Recipient bounced ${row.bounceCount} ${times(row.bounceCount)}, most recently on ${day(row.lastBouncedAt)}.`,
      detail: { bounce_count: row.bounceCount, last_bounced_at: row.lastBouncedAt.toISOString() },
    };
  }

  if (
    row.deferredCount >= HISTORY_DEFERRAL_COUNT &&
    row.lastDeferredAt &&
    !recoveredSince(row.lastDeliveredAt, row.lastDeferredAt)
  ) {
    return {
      code: "frequent_deferrals",
      address: row.address,
      message: `Sends to this recipient deferred ${row.deferredCount} ${times(row.deferredCount)}, most recently on ${day(row.lastDeferredAt)}.`,
      detail: { deferred_count: row.deferredCount, last_deferred_at: row.lastDeferredAt.toISOString() },
    };
  }

  return null;
}

/** Warnings for a send's recipients, this organization's history only. */
export async function warningsFor(organizationId: string, addresses: string[]): Promise<MessageWarning[]> {
  const rows = await historyFor(organizationId, addresses);
  return rows.map(evaluateHistory).filter((warning): warning is MessageWarning => warning !== null);
}
