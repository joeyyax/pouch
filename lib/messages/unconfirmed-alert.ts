/**
 * Pushes once when unconfirmed marks cross into clustered, and re-arms when they fall back out.
 *
 * The admin system screen is the detail view, but a cluster is a transient outage that closes
 * itself — the window can roll before anyone opens the page, so the alert goes over ntfy
 * instead of waiting there (docs/engineering.md, "Admin alerts use push").
 */
import { readLoopLiveness, readUnconfirmedCluster } from "@/lib/system/read";
import { logger } from "@/lib/logger";
import { sendUnconfirmedClusterAlert } from "@/lib/notifications/push/unconfirmed-cluster";
import { redis } from "@/lib/redis";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("messages:unconfirmed-alert");

/** Which side of the line the last check saw. No TTL: a cluster that lasts a week still pushes once. */
const ALERT_KEY = "unconfirmed-cluster-alert";

/** True when some worker's marking loop is inside its own staleness window, as the screen reads it. */
async function marking(): Promise<boolean> {
  const loops = await readLoopLiveness();
  return loops.some((loop) => loop.loop === "abandon" && loop.status === "ok");
}

/**
 * Checks the cluster window and pushes on the way in. Returns true when it pushed.
 *
 * Skipped unless the marking loop is alive: nothing marking means no marks means 0%, which reads
 * exactly like healthy, and a sweep coming back after an outage marks its backlog in a burst.
 * The screen carries the same guard (#408). Redis holds the flag, so with Redis unreachable the
 * liveness read comes back empty and the check does nothing rather than push on a bare number.
 */
export async function checkUnconfirmedCluster(): Promise<boolean> {
  const client = redis();
  if (!client) return false;
  if (!(await marking())) return false;

  const view = await readUnconfirmedCluster();
  if (!view.clustered) {
    await client.del(ALERT_KEY);
    return false;
  }

  if ((await client.set(ALERT_KEY, "1", "NX")) !== "OK") return false;
  try {
    await sendUnconfirmedClusterAlert(view);
  } catch (err) {
    // Put the flag back, or one failed post swallows the only alert this transition gets.
    await client.del(ALERT_KEY);
    log.warn(`couldn't send the unconfirmed cluster alert: ${safeErrorMessage(err)}`);
    return false;
  }
  return true;
}

/** Test hook: forgets the transition already alerted on. */
export async function resetUnconfirmedClusterAlert(): Promise<void> {
  const client = redis();
  if (client) await client.del(ALERT_KEY);
}
