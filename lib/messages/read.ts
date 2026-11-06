import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, type OwnedMessageRow } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { keyCanAccessDomain } from "@/lib/api/keys";
import type { MessageCaller } from "./list";

/** One message the caller can read, or `not_found` / `key_not_scoped`. */
export async function findMessage(caller: MessageCaller, id: string): Promise<OwnedMessageRow> {
  const [message] = await db
    .select()
    .from(messages)
    // A test key reads only test mail: a live message is out of its sandbox, so it isn't there.
    .where(and(eq(messages.organizationId, caller.organizationId), eq(messages.id, id), caller.mode === "test" ? eq(messages.testMode, true) : undefined))
    .limit(1);

  if (!message) throw new ApiError("not_found", `No message with id ${id}.`);
  if (!keyCanAccessDomain(caller, message.domainId)) {
    throw new ApiError("key_not_scoped", "This key can't read this message.");
  }
  return message as OwnedMessageRow;
}
