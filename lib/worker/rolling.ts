/** Options for one rolling pass. */
export interface RollingPass<T> {
  /** Items in flight at most. */
  limit: number;
  /** Stops claiming after this long; what's in flight still finishes. */
  budgetMs: number;
  /** Up to `room` due items, claimed so no other worker takes them. */
  claim: (room: number) => Promise<T[]>;
  /** Handles one item. Must not throw. */
  work: (item: T) => Promise<void>;
  /** Read before each claim, so a stopping loop claims nothing more. */
  stopped: () => boolean;
}

/**
 * Keeps up to `limit` items in flight, claiming another as each finishes, until nothing is due,
 * the budget runs out or the loop stops. A slow item holds one slot instead of a whole batch.
 * `backlog` is set when the budget ran out with work still being claimed, so the caller can go again.
 */
export async function rollingPass<T>({ limit, budgetMs, claim, work, stopped }: RollingPass<T>): Promise<{ claimed: number; backlog: boolean }> {
  const deadline = Date.now() + budgetMs;
  const inFlight = new Set<Promise<void>>();
  let claimed = 0;
  let drained = false;

  while (!stopped() && Date.now() < deadline) {
    const room = limit - inFlight.size;
    const items = room > 0 ? await claim(room) : [];
    for (const item of items) {
      const running: Promise<void> = work(item).finally(() => inFlight.delete(running));
      inFlight.add(running);
    }
    claimed += items.length;
    if (inFlight.size === 0) {
      drained = true;
      break;
    }
    // Full, or nothing due right now: wait for a slot before claiming again.
    if (items.length === 0 || inFlight.size >= limit) await Promise.race(inFlight);
  }

  await Promise.all(inFlight);
  return { claimed, backlog: !drained && !stopped() };
}
