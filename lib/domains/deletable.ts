import { and, asc, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { batches, lists, messages } from "@/lib/db/schema";
import { resolveSystemSenderFor, SystemMailNotConfiguredError } from "@/lib/mail/system";
import { readServiceSettings } from "@/lib/settings/service";

/** What holds a domain in place, in the words the caller reads. Null means the delete can run. */
export type DomainDeleteBlock = {
  message: string;
  /** Lists on the domain, which an operator can delete. Empty when a send record is what blocks it. */
  lists: { id: string; name: string }[];
};

/** Lists named in the message before it counts the rest. */
const NAMED = 5;

/** Mail still owed to someone. */
const IN_FLIGHT = ["queued", "deferred"] as const;

/**
 * Everything `domains.id` is referenced by under `onDelete: "restrict"`, plus messages. Read
 * inside the delete's own transaction so the answer and the delete see the same rows. The
 * service's own mail blocks only while it's waiting to send; once sent, it goes with the domain.
 */
export async function domainDeleteBlock(
  domain: { id: string; name: string },
  tx: Executor = db,
): Promise<DomainDeleteBlock | null> {
  const [sent] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.domainId, domain.id), isNotNull(messages.organizationId)))
    .limit(1);
  if (sent) {
    return { message: `Domain ${domain.name} has messages and can't be deleted. The log is the record.`, lists: [] };
  }

  if (await sendsSystemMail(domain.id)) {
    return { message: `Domain ${domain.name} sends system mail. Point the system from address at another domain first.`, lists: [] };
  }

  const [waiting] = await tx
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.domainId, domain.id), isNull(messages.organizationId), inArray(messages.status, [...IN_FLIGHT])));
  if (waiting && waiting.n > 0) {
    return {
      message: `Domain ${domain.name} has ${waiting.n} system mail ${waiting.n === 1 ? "message" : "messages"} waiting to send. Try again once they've sent.`,
      lists: [],
    };
  }

  const [batch] = await tx.select({ id: batches.id }).from(batches).where(eq(batches.domainId, domain.id)).limit(1);
  if (batch) {
    return { message: `Domain ${domain.name} has batches and can't be deleted. The log is the record.`, lists: [] };
  }

  const bound = await tx
    .select({ id: lists.id, name: lists.name })
    .from(lists)
    .where(eq(lists.domainId, domain.id))
    .orderBy(asc(lists.name));
  if (bound.length === 0) return null;

  return { message: listRefusal(domain.name, bound.map((list) => list.name)), lists: bound };
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

/** Deletes the service's own mail sent from the domain, which `domainDeleteBlock` lets go with it. */
export async function dropServiceMail(domainId: string, tx: Executor): Promise<void> {
  await tx.delete(messages).where(and(eq(messages.domainId, domainId), isNull(messages.organizationId)));
}

function listRefusal(name: string, names: string[]): string {
  const shown = names.slice(0, NAMED);
  const rest = names.length - shown.length;
  const named = rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
  const one = names.length === 1;
  return `Domain ${name} has ${names.length} ${one ? "list" : "lists"} and can't be deleted: ${named}. Delete ${one ? "it" : "them"} first.`;
}
