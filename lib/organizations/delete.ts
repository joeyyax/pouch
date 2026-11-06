/**
 * Deleting an organization: its domains and the identities behind them, its provider rows and
 * the spaces they hold at the provider, then the row everything else cascades from.
 *
 * The atomic unit is the domain, not the organization. Each domain's row and its provider call
 * share one transaction, the way `deleteDomain` does, so an identity never orphans and a row
 * never survives without one. Stretching a single transaction across every domain would hold
 * the whole organization's rows locked for as long as the slowest provider takes, and would
 * make one dead identity enough to stop a twenty-domain organization being deleted at all.
 * A failure part way leaves the domains already dropped gone and the organization intact, and
 * every step is re-runnable, so the way out is to call it again.
 */
import { asc, count, eq } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { batches, dnsProviderRecords, domains, lists, messages, organizations, providers } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { logger } from "@/lib/logger";
import { unindexOrganization } from "@/lib/search";
import { adapterFor } from "@/lib/providers";
import { dropDomain, type DomainRow } from "@/lib/domains";
import { lockedOrganization, organizationDeleteBlock } from "./deletable";

const log = logger.child("organizations");

export interface DeletedOrganization {
  id: string;
  deleted: true;
  /** What went with it, counted before the delete, so the caller can report it. */
  domains: number;
  messages: number;
}

/** What the confirmation screens count before asking. */
export interface OrganizationContents {
  domains: number;
  messages: number;
}

export async function organizationContents(organizationId: string): Promise<OrganizationContents> {
  const [domainCount, messageCount] = await Promise.all([
    db.select({ n: count() }).from(domains).where(eq(domains.organizationId, organizationId)),
    db.select({ n: count() }).from(messages).where(eq(messages.organizationId, organizationId)),
  ]);
  return { domains: domainCount[0]?.n ?? 0, messages: messageCount[0]?.n ?? 0 };
}

/**
 * Deletes the organization and everything that belongs to it. Refused while it has mail waiting
 * to send or holds the domain Pouch's own mail sends from (`organizationDeleteBlock`).
 */
export async function deleteOrganization(organizationId: string, actor: ActivityActor): Promise<DeletedOrganization> {
  const [organization] = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization) throw new ApiError("not_found", `No organization with id ${organizationId}.`);

  await assertDeletable(organization);
  const contents = await organizationContents(organizationId);

  const rows = await db
    .select()
    .from(domains)
    .where(eq(domains.organizationId, organizationId))
    .orderBy(asc(domains.createdAt), asc(domains.id));
  for (const domain of rows) await dropOrganizationDomain(domain);

  await releaseProviders(organizationId);

  await db.transaction(async (tx) => {
    const live = await lockedOrganization(organizationId, tx);
    if (!live) throw new ApiError("not_found", `No organization with id ${organizationId}.`);
    await assertDeletable(live, tx);

    // Both pairs are `restrict` against a sibling that cascades from the organization too, so
    // the child goes first rather than leaving the cascade's order to decide.
    await tx.delete(dnsProviderRecords).where(eq(dnsProviderRecords.organizationId, organizationId));
    await tx.delete(messages).where(eq(messages.organizationId, organizationId));
    await tx.delete(providers).where(eq(providers.organizationId, organizationId));

    await tx.delete(organizations).where(eq(organizations.id, organizationId));
  });
  unindexOrganization(organizationId);

  // Service-level: the organization it would otherwise record against is gone.
  await recordActivity({
    organizationId: null,
    action: "organization.deleted",
    actor,
    appliesTo: organization.id,
    subjectLabel: organization.name,
    metadata: { slug: organization.slug, domains: contents.domains, messages: contents.messages },
  });

  return { id: organization.id, deleted: true, ...contents };
}

async function assertDeletable(organization: { id: string; name: string }, tx: Executor = db): Promise<void> {
  const block = await organizationDeleteBlock(organization, tx);
  if (block) throw new ApiError("organization_in_use", block.message, { detail: { reason: block.reason } });
}

/**
 * One domain, one transaction: its send records, its row, then the identity at the provider.
 * The records go first because they're `restrict` against the row — an organization's history
 * is deleted with it, which is what makes this different from deleting one domain.
 */
async function dropOrganizationDomain(domain: DomainRow): Promise<void> {
  const [provider] = await db.select().from(providers).where(eq(providers.id, domain.providerId)).limit(1);
  if (!provider) throw new ApiError("provider_unavailable", `${domain.name} has no provider row to remove it from.`);
  const client = adapterFor(provider);

  await db.transaction(async (tx) => {
    await tx.delete(messages).where(eq(messages.domainId, domain.id));
    await tx.delete(batches).where(eq(batches.domainId, domain.id));
    await tx.delete(lists).where(eq(lists.domainId, domain.id));
    await dropDomain(domain, client, tx);
  });
}

/**
 * Tears down each provider row the organization holds and the space behind it. A shared
 * provider carries a null organization, so this can never select one.
 */
async function releaseProviders(organizationId: string): Promise<void> {
  const rows = await db.select().from(providers).where(eq(providers.organizationId, organizationId));
  for (const provider of rows) {
    try {
      await adapterFor(provider).setup?.teardown?.();
    } catch (err) {
      throw new ApiError("provider_unavailable", `Provider couldn't release ${provider.name}: ${(err as Error).message}`);
    }
    await db.delete(providers).where(eq(providers.id, provider.id));
    log.info(`released provider ${provider.id} from ${organizationId}`);
  }
}
