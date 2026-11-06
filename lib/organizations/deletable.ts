import { and, count, eq, inArray } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { domains, messages, organizations } from "@/lib/db/schema";
import { resolveSystemSender, SystemMailNotConfiguredError } from "@/lib/mail/system";
import { brand } from "@/lib/brand";

/** What holds an organization in place, in the words the caller reads. Null means the delete can run. */
export type OrganizationDeleteBlock = {
  message: string;
  reason: "mail_in_flight" | "system_mail";
};

/** Mail Pouch still owes the customer. Anything else has already left. */
const IN_FLIGHT = ["queued", "deferred"] as const;

/**
 * Two things stop an organization going, and neither is its history. Sending records cascade
 * with it on purpose — deleting the organization is deliberately taking the whole record, which
 * is the difference between this and `domainDeleteBlock`.
 */
export async function organizationDeleteBlock(
  organization: { id: string; name: string },
  tx: Executor = db,
): Promise<OrganizationDeleteBlock | null> {
  const [row] = await tx
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.organizationId, organization.id), inArray(messages.status, [...IN_FLIGHT])));
  const waiting = row?.n ?? 0;
  if (waiting > 0) {
    return {
      reason: "mail_in_flight",
      message: `${organization.name} has ${waiting} ${waiting === 1 ? "message" : "messages"} waiting to send. Suspend it to fail them, or wait for them to send.`,
    };
  }

  const systemDomain = await systemMailDomainIn(organization.id, tx);
  if (systemDomain) {
    return {
      reason: "system_mail",
      message: `${organization.name} holds ${systemDomain}, which ${brand.name} sends its own mail from. Point the system from address at another domain first.`,
    };
  }

  return null;
}

/**
 * The domain system mail resolves to right now, when this organization is the one holding it.
 * An install whose system mail already doesn't resolve has nothing to lose here.
 */
async function systemMailDomainIn(organizationId: string, tx: Executor): Promise<string | null> {
  let sender;
  try {
    sender = await resolveSystemSender();
  } catch (err) {
    if (err instanceof SystemMailNotConfiguredError) return null;
    throw err;
  }
  if (sender.organizationId !== organizationId) return null;

  // The row is read back through the transaction so a domain deleted in it counts as gone.
  const [live] = await tx
    .select({ name: domains.name })
    .from(domains)
    .where(and(eq(domains.id, sender.domainId), eq(domains.organizationId, organizationId)))
    .limit(1);
  return live?.name ?? null;
}

/** The organization's row, locked for the rest of the caller's transaction. */
export async function lockedOrganization(
  organizationId: string,
  tx: Executor,
): Promise<{ id: string; name: string; slug: string } | null> {
  const [row] = await tx
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update")
    .limit(1);
  return row ?? null;
}
