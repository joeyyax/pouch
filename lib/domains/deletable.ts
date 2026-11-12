import { and, count, eq, inArray } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { batches, lists, messages } from "@/lib/db/schema";
import { resolveSystemSenderFor, SystemMailNotConfiguredError } from "@/lib/mail/system";
import { readServiceSettings } from "@/lib/settings/service";

/** What holds a domain in place, in the words the caller reads. Null means the delete can run. */
export type DomainDeleteBlock = { message: string };

/** What a delete takes with it, counted for the confirmation and the activity record. */
export interface DomainContents {
  messages: number;
  lists: number;
}

/** Mail still owed to someone. */
const IN_FLIGHT = ["queued", "deferred"] as const;

/**
 * Only mail still owed and the system from address hold a domain. Its history goes with it.
 * Read inside the delete's own transaction so the answer and the delete see the same rows.
 */
export async function domainDeleteBlock(
  domain: { id: string; name: string },
  tx: Executor = db,
): Promise<DomainDeleteBlock | null> {
  if (await sendsSystemMail(domain.id)) {
    return { message: `Domain ${domain.name} sends system mail. Point the system from address at another domain first.` };
  }

  const [waiting] = await tx
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.domainId, domain.id), inArray(messages.status, [...IN_FLIGHT])));
  if (waiting && waiting.n > 0) {
    return {
      message: `Domain ${domain.name} has ${waiting.n} ${waiting.n === 1 ? "message" : "messages"} waiting to send. Try again once ${waiting.n === 1 ? "it's" : "they've"} sent.`,
    };
  }
  return null;
}

export async function domainContents(domainId: string, tx: Executor = db): Promise<DomainContents> {
  const [[sent], [held]] = await Promise.all([
    tx.select({ n: count() }).from(messages).where(eq(messages.domainId, domainId)),
    tx.select({ n: count() }).from(lists).where(eq(lists.domainId, domainId)),
  ]);
  return { messages: sent?.n ?? 0, lists: held?.n ?? 0 };
}

/** Deletes the domain's messages, batches and lists ahead of its row. Returns the message ids. */
export async function dropDomainHistory(domainId: string, tx: Executor): Promise<string[]> {
  const dropped = await tx.delete(messages).where(eq(messages.domainId, domainId)).returning({ id: messages.id });
  await tx.delete(batches).where(eq(batches.domainId, domainId));
  await tx.delete(lists).where(eq(lists.domainId, domainId));
  return dropped.map((row) => row.id);
}

/** Whether the system from address names this domain. Unset, the fallback moves to the next verified domain on its own. */
async function sendsSystemMail(domainId: string): Promise<boolean> {
  const { systemFromAddress } = await readServiceSettings();
  if (!systemFromAddress) return false;
  try {
    return (await resolveSystemSenderFor(systemFromAddress)).domainId === domainId;
  } catch (err) {
    if (err instanceof SystemMailNotConfiguredError) return false;
    throw err;
  }
}
