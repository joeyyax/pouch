import { sql, type SQL } from "drizzle-orm";
import { messageEvents, messages } from "@/lib/db/schema";

/** A bounce or complaint on the message carried exactly this reason. */
export function bounceReasonCondition(reason: string): SQL {
  return sql`exists (select 1 from ${messageEvents} where ${messageEvents.messageId} = ${messages.id} and ${messageEvents.status} in ('bounced', 'complained') and ${messageEvents.reason} = ${reason})`;
}
