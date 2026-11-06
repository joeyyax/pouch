/** The one order a message's events read in: when, then where in the lifecycle, then id. */
import { asc, sql, type SQL } from "drizzle-orm";
import { messageEvents, MESSAGE_STATUSES } from "@/lib/db/schema";
import { LIFECYCLE_RANK } from "./lifecycle";

/** Events without a status sort after the transitions they tie with. */
const UNRANKED = Math.max(...Object.values(LIFECYCLE_RANK)) + 1;

/** An event's lifecycle rank, in SQL. Built from constants, never from input. */
export const eventRank: SQL<number> = sql<number>`(case ${messageEvents.status} ${sql.raw(
  MESSAGE_STATUSES.map((status) => `when '${status}' then ${LIFECYCLE_RANK[status]}`).join(" "),
)} else ${sql.raw(String(UNRANKED))} end)`;

/** Oldest first. A tie on occurred_at, which a provider's coarse timestamp or one transaction's now() produces, reads in lifecycle order. */
export const EVENTS_OLDEST_FIRST = [asc(messageEvents.occurredAt), asc(eventRank), asc(messageEvents.id)] as const;

/** Events after the cursor event in oldest-first order. The cursor's row is read in SQL to keep its microseconds. */
export function eventsAfter(cursorId: string): SQL {
  return sql`(${messageEvents.occurredAt}, ${eventRank}, ${messageEvents.id}) > (select ${messageEvents.occurredAt}, ${eventRank}, ${messageEvents.id} from ${messageEvents} where ${messageEvents.id} = ${cursorId})`;
}
