import type { MessageStatus } from "@/lib/db/schema";

/**
 * `queued → sent → delivered | deferred | bounced | complained | failed`, with deferred able to
 * return to sent, and delivered able to move on to complained or bounced.
 *
 * A complaint is always after delivery — someone has to receive a message to report it — so a
 * terminal `delivered` made `complained` a status no message could ever hold. An asynchronous
 * bounce is the same shape: the receiving server accepts, then gives up hours later.
 *
 * `delivered_at` survives both. The row keeps the fact that it arrived; the status says what
 * happened to it after.
 */
const ALLOWED: Record<MessageStatus, readonly MessageStatus[]> = {
  queued: ["sent", "failed"],
  sent: ["delivered", "deferred", "bounced", "complained", "failed"],
  deferred: ["sent", "delivered", "bounced", "complained", "failed"],
  delivered: ["complained", "bounced"],
  bounced: [],
  complained: [],
  failed: [],
};

/**
 * The statuses where the send is over and nothing is pending — what a progress view stops
 * waiting on. Not the same as having no transitions left: a delivered message is finished, and
 * can still be complained about a day later.
 */
export const TERMINAL_STATUSES: readonly MessageStatus[] = ["delivered", "bounced", "complained", "failed"];

/**
 * Each status's place in a message's life: its longest path from `queued` through ALLOWED, with
 * the deferred-to-sent retry left out. Statuses that never follow one another can share a rank.
 */
function lifecycleRanks(): Record<MessageStatus, number> {
  const rank: Partial<Record<MessageStatus, number>> = {};
  const visit = (status: MessageStatus, depth: number, path: ReadonlySet<MessageStatus>) => {
    rank[status] = Math.max(rank[status] ?? 0, depth);
    for (const next of ALLOWED[status]) if (!path.has(next)) visit(next, depth + 1, new Set([...path, status]));
  };
  visit("queued", 0, new Set());
  return rank as Record<MessageStatus, number>;
}

export const LIFECYCLE_RANK: Readonly<Record<MessageStatus, number>> = lifecycleRanks();

export function canTransition(from: MessageStatus, to: MessageStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function isTerminal(status: MessageStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function nextStatuses(from: MessageStatus): readonly MessageStatus[] {
  return ALLOWED[from];
}

/** Guards a status write. A rejected transition is a bug in the caller, not a provider outcome. */
export function assertTransition(from: MessageStatus, to: MessageStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`A message can't go from ${from} to ${to}.`);
  }
}
