import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { messages } from "@/lib/db/schema";
import { applyEvent } from "@/lib/messages/events";
import { logger } from "@/lib/logger";
import type { NormalizedEvent } from "@/lib/providers/adapters/types";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { reportError } from "@/lib/errors/report";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker:test-mode");

/** `slow@` waits this many times the base delay before resolving — a backoff-style demo, not a different terminal status. */
export const SLOW_DELAY_MULTIPLIER = 4;

export interface TestModeLoopOptions {
  /** Defaults for a single-loop test harness that has no worker process around it. */
  workerId?: string;
  /** How often the loop wakes up. */
  intervalMs: number;
  /** Messages resolved per pass. */
  batchSize: number;
  /** How long a test-mode message sits at `sent` before it's resolved. */
  delayMs: number;
}

/** Convention `mock.ts` already uses for the special local parts. */
function localPart(address: string): string {
  return address.split("@")[0]?.toLowerCase() ?? "";
}

/**
 * Resolves test-mode messages the mock provider will never get a webhook for.
 *
 * A test-mode key delivers nothing, so nothing ever calls back with a `delivered` event.
 * This loop stands in for that callback: a few seconds after a test-mode message reaches
 * `sent`, it synthesizes a `NormalizedEvent` and pushes it through the same `applyEvent` a
 * real provider's webhook uses, so suppression, the message-events row and the dashboard
 * live-update all happen exactly as they would for a real send. The recipient's local part
 * picks the outcome: `bounce` synthesizes `bounced` (and suppresses); `defer` synthesizes
 * `deferred` and stops there — a message sitting at `deferred` is itself the demo, the way
 * `sent → deferred → sent` retries look mid-flight for a real provider; `slow` waits
 * `SLOW_DELAY_MULTIPLIER` times longer than everything else before resolving to `delivered`,
 * standing in for a provider backoff; anything else resolves to `delivered` at the normal delay.
 */
export class TestModeLoop extends IntervalLoop<{ resolved: number }> {
  protected readonly name = "test-mode";
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;

  constructor(private readonly options: TestModeLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<{ resolved: number }> {
    // sent_at is written on the database's clock, so the cutoff it's compared against is too.
    const now = await dbNow();
    const cutoff = new Date(now.getTime() - this.options.delayMs);

    const due = await db
      .select({
        id: messages.id,
        organizationId: messages.organizationId,
        providerId: messages.providerId,
        providerMessageId: messages.providerMessageId,
        recipients: messages.recipients,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.testMode, true),
          eq(messages.status, "sent"),
          isNotNull(messages.providerId),
          isNotNull(messages.providerMessageId),
          isNotNull(messages.sentAt),
          lte(messages.sentAt, cutoff),
        ),
      )
      .orderBy(asc(messages.sentAt))
      .limit(this.options.batchSize);

    let resolved = 0;

    for (const row of due) {
      if (this.stopped) break;
      // The query already filters these out; the checks here are only for the type.
      if (!row.providerId || !row.providerMessageId || !row.sentAt) continue;

      const bounced = row.recipients.filter((address) => localPart(address) === "bounce");
      const deferred = row.recipients.filter((address) => localPart(address) === "defer");
      const slow = row.recipients.filter((address) => localPart(address) === "slow");

      // slow@ isn't due yet by the normal delay — leave it for a later tick, the way a real
      // provider backoff would, rather than resolving it early.
      if (bounced.length === 0 && deferred.length === 0 && slow.length > 0) {
        const slowCutoff = new Date(now.getTime() - this.options.delayMs * SLOW_DELAY_MULTIPLIER);
        if (row.sentAt > slowCutoff) continue;
      }

      const event: NormalizedEvent =
        bounced.length > 0
          ? {
              providerMessageId: row.providerMessageId,
              providerEventId: null,
              status: "bounced",
              reason: "Mailbox does not exist",
              occurredAt: now,
              detail: {},
              recipients: bounced,
            }
          : deferred.length > 0
            ? {
                providerMessageId: row.providerMessageId,
                providerEventId: null,
                status: "deferred",
                reason: "Temporary failure, try again",
                occurredAt: now,
                detail: {},
                recipients: deferred,
              }
            : {
                providerMessageId: row.providerMessageId,
                providerEventId: null,
                status: "delivered",
                reason: null,
                occurredAt: now,
                detail: {},
                recipients: [],
              };

      // Per row, because the batch is ordered by sent_at and re-selected every tick: one row
      // that throws would abort the pass, and the next pass would pick the same rows in the
      // same order and die on the same one. Every test-mode message behind it stops resolving,
      // every two seconds, indefinitely — and test mode is the first thing a new integrator
      // touches.
      try {
        const applied = await applyEvent({ id: row.providerId, organizationId: row.organizationId }, event);
        if (applied.outcome === "recorded") resolved += 1;
      } catch (err) {
        log.error(`resolving test-mode message ${row.id} threw: ${safeErrorMessage(err)}`);
        reportError(err, {
          errorCode: "test_mode_resolve_failed",
          messageId: row.id,
          organizationId: row.organizationId ?? undefined,
        });
      }
    }

    if (resolved > 0) log.info(`resolved ${resolved} test-mode message(s)`);
    return { resolved };
  }

}
