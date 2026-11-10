import { and, desc, eq, inArray } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, organizations, providers } from "@/lib/db/schema";
import { loadProvider, mergeSettings, adapterFor, type ProviderRow } from "@/lib/providers";
import { ApiError } from "@/lib/api/errors";
import { keyCanAccessDomain } from "@/lib/api/keys";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { newId } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { capabilitiesOf, isConfiguredFor, stepsFor } from "@/lib/providers/adapters";
import { bulkNotAllowedMessage } from "@/lib/bulk/allowed";
import {
  DomainApiUnavailableError,
  DomainNotAtProviderError,
  DomainUnavailableError,
  type Adapter,
  type AdapterCapabilities,
  type AdapterCapabilityFlag,
  type CreatedDomain,
  type WebhookTarget,
} from "@/lib/providers/adapters/types";
import { webhookUrl } from "@/lib/webhooks/url";
import type { AdoptDomainRequest, CreateDomainRequest } from "@/lib/schemas/domain";
import { readDomainReputation, readDomainStanding, readOrganizationReputation, type DomainReputation } from "@/lib/reputation/read";
import { serializeDomainReputation } from "@/lib/reputation/serialize";
import { standingReason } from "@/lib/reputation/standing";
import { validationError } from "@/lib/schemas/validation-error";
import { ZodError } from "zod";
import { checkDmarc, dmarcBlocksBulk } from "./dmarc";
import { dmarcReportUri, dmarcReportUris } from "@/lib/dmarc/host";
import { mergeLayout, serializeLayout, type DomainLayout, type LayoutPatch } from "./layout";
import { deleteUploadedLogoIfOurs } from "./logo-upload";
import { serializeDomain, type DomainStandingSummary, type SerializedDomain } from "./serialize";
import { domainDeleteBlock, dropServiceMail } from "./deletable";
import { nextVerificationState, providerAnswered } from "./verification";
import { keysetBefore } from "@/lib/db/keyset";
import { closeInboundRoute } from "@/lib/inbound/records";

const log = logger.child("domains");

/**
 * Who is asking. An API key and a dashboard session differ only in scope, so every read and
 * write below takes this rather than a key row, and the same code path serves both.
 */
export interface DomainCaller {
  organizationId: string;
  /** Domain ids the caller may reach. Empty means every domain in the organization. */
  domainIds: string[];
  actor: ActivityActor;
}

export type DomainRow = typeof domains.$inferSelect;

/**
 * Reads what the adapter can't do through its API as a request error, not a silent no-op. The
 * detail carries the steps left to the provider's dashboard, which is what a caller can act on.
 */
export function assertCan(
  capabilities: AdapterCapabilities,
  key: AdapterCapabilityFlag,
  action: string,
  context: WebhookTarget,
): void {
  if (capabilities[key] === true) return;
  throw new ApiError("capability_unavailable", `This domain's provider can't ${action} through its API.`, {
    detail: { setup: stepsFor(capabilities, context) },
  });
}

/** Loads a domain in the key's organization and scope, or throws the error that says why not. */
export async function domainFor(key: DomainCaller, id: string): Promise<DomainRow> {
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.organizationId, key.organizationId), eq(domains.id, id)))
    .limit(1);
  if (!domain) throw new ApiError("not_found", `No domain with id ${id}.`);
  if (!keyCanAccessDomain(key, domain.id)) {
    throw new ApiError("key_not_scoped", `This key can't read ${domain.name}.`);
  }
  return domain;
}

/** The domain's reputation standing as API responses carry it. */
async function standingFor(organizationId: string, domainId: string): Promise<DomainStandingSummary> {
  const result = await readDomainStanding(organizationId, domainId, await dbNow());
  return result ? { standing: result.standing, reason: standingReason(result) } : { standing: "healthy", reason: null };
}

/** What the provider does with the name before the row lands: create the identity, or adopt one. */
interface DomainOrigin {
  capability: "domainsViaApi" | "adoptionViaApi";
  /** What a caller can't do, as `capability_unavailable` phrases it. */
  action: string;
  activity: "domain.added" | "domain.adopted";
  at(adapter: Adapter, name: string): Promise<CreatedDomain>;
}

const CREATED: DomainOrigin = {
  capability: "domainsViaApi",
  action: "add a domain",
  activity: "domain.added",
  at: (adapter, name) => adapter.domain.create(name),
};

const ADOPTED: DomainOrigin = {
  capability: "adoptionViaApi",
  action: "adopt an existing domain",
  activity: "domain.adopted",
  // Guarded by the capability above, which is false on every adapter without it.
  at: (adapter, name) => adapter.domain.adopt!(name),
};

/**
 * Stands the domain up at the provider and stores what it asked for. The provider's event
 * plumbing is built on the first domain that needs it and reused by the rest.
 */
async function landDomain(
  key: DomainCaller,
  request: CreateDomainRequest,
  origin: DomainOrigin,
): Promise<{ row: DomainRow; provider: ProviderRow; eventsConfigured: boolean }> {
  // A scoped key can't read, verify or delete a domain it isn't scoped to, so letting it create
  // one leaves real provider resources it can never reach again.
  if (key.domainIds.length > 0) {
    throw new ApiError("key_not_scoped", "This key is scoped to specific domains and can't add one.");
  }

  const provider = await loadProvider(key, request.provider_id ?? (await assignedProviderId(key.organizationId)), "provider_id");
  const capabilities = capabilitiesOf(provider.adapter);
  assertCan(capabilities, origin.capability, origin.action, { webhookUrl: webhookUrl(provider.adapter, provider.id) });

  const [existing] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.organizationId, key.organizationId), eq(domains.name, request.name)))
    .limit(1);
  if (existing) {
    throw new ApiError("domain_exists", `Domain ${request.name} is already on this provider.`, { field: "name" });
  }

  const client = adapterFor(provider);
  let created;
  try {
    created = await origin.at(client, request.name);
  } catch (err) {
    throw providerDomainError(err, provider);
  }
  const eventsConfigured = await configureEvents(provider, request.name, undefined, client);

  const id = newId("domain");
  const [row] = await db
    .insert(domains)
    .values({
      id,
      organizationId: key.organizationId,
      providerId: provider.id,
      name: request.name,
      status: "pending",
      providerDomainId: created.providerDomainId,
      dnsRecords: created.records,
      // Everything's missing until the provider says otherwise (mirrors moveDomain).
      missingRecords: created.records,
    })
    .returning();

  if (!row) throw new ApiError("provider_unavailable", "The domain couldn't be persisted.");

  await recordActivity({
    organizationId: key.organizationId,
    action: origin.activity,
    actor: key.actor,
    appliesTo: row.id,
    subjectLabel: row.name,
  });

  return { row, provider, eventsConfigured };
}

/** Creates the domain at the provider and stores the records it asked for. */
export async function createDomain(key: DomainCaller, request: CreateDomainRequest): Promise<SerializedDomain> {
  const { row, provider, eventsConfigured } = await landDomain(key, request, CREATED);
  return serializeDomain(row, {
    adapter: provider.adapter,
    providerId: provider.id,
    eventsConfigured,
    reputation: await standingFor(key.organizationId, row.id),
    reportUri: await dmarcReportUri(row),
  });
}

/**
 * Takes over an identity the provider already holds, keeping its signing keys, and verifies it
 * straight away — an identity that was already sending lands verified rather than pending.
 * Admin-only: `POST /v1/domains` still answers `domain_unavailable` for the same name.
 */
export async function adoptDomain(key: DomainCaller, request: CreateDomainRequest): Promise<SerializedDomain> {
  const { row } = await landDomain(key, request, ADOPTED);
  return verifyDomain(key, row.id);
}

/** Adopts for an organization the caller isn't in. Reached only from the admin route and screen. */
export async function adoptDomainForOrganization(request: AdoptDomainRequest, actor: ActivityActor): Promise<SerializedDomain> {
  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, request.organization_id))
    .limit(1);
  if (!organization) {
    throw new ApiError("not_found", `No organization with id ${request.organization_id}.`, { field: "organization_id" });
  }
  return adoptDomain({ organizationId: organization.id, domainIds: [], actor }, request);
}

/** The organization's default provider, or `provider_unassigned`. */
async function assignedProviderId(organizationId: string): Promise<string> {
  const [org] = await db
    .select({ providerId: organizations.providerId })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!org?.providerId) {
    throw new ApiError("provider_unassigned", "This organization can't add a domain yet. An admin needs to assign it a provider.", {
      field: "provider_id",
    });
  }
  return org.providerId;
}

function providerDomainError(err: unknown, provider: ProviderRow): ApiError {
  if (err instanceof DomainApiUnavailableError) {
    const capabilities = { ...capabilitiesOf(provider.adapter), domainsViaApi: false, dnsRecordsViaApi: false };
    return new ApiError("capability_unavailable", "This domain's provider can't add a domain through its API.", {
      detail: { setup: stepsFor(capabilities, { webhookUrl: webhookUrl(provider.adapter, provider.id) }) },
    });
  }
  if (err instanceof DomainUnavailableError) return new ApiError("domain_unavailable", err.message);
  if (err instanceof DomainNotAtProviderError) return new ApiError("domain_not_at_provider", err.message, { field: "name" });
  return new ApiError("provider_unavailable", `Provider rejected the domain: ${(err as Error).message}`);
}

/**
 * Builds the provider-side event plumbing once per provider and stores what it created. Returns
 * whether the provider is configured now, which the response reports as a remaining setup step.
 */
export async function configureEvents(
  provider: ProviderRow,
  domain: string,
  identities?: string[],
  // The client that just created a tenant, so setup reuses its ARN instead of looking it up again.
  client: Adapter = adapterFor(provider),
): Promise<boolean> {
  if (!client.setup) return true;
  if (client.setup.isConfigured(provider.settings)) return true;

  try {
    const configured = await client.setup.configureEvents(domain, {
      webhookUrl: webhookUrl(provider.adapter, provider.id),
      save: (patch) => mergeSettings(provider.id, patch),
      identities,
    });
    await mergeSettings(provider.id, configured.settings);
    return client.setup.isConfigured({ ...provider.settings, ...configured.settings });
  } catch (err) {
    // The domain row still lands: the identity exists at the provider either way, and the
    // response names the unfinished step. Every step is re-runnable on the next verify.
    log.warn(`configuring events for ${provider.id} failed: ${safeErrorMessage(err)}`);
    return false;
  }
}

/** Asks the provider where verification stands and writes what it says. */
export async function verifyDomain(key: DomainCaller, id: string): Promise<SerializedDomain> {
  const domain = await domainFor(key, id);
  const provider = await loadProvider(key, domain.providerId, "provider_id");

  // The only door back to a setup that failed part way through create.
  const eventsConfigured = await configureEvents(provider, domain.name);

  const status = await adapterFor(provider).domain.verify(domain.name, domain.providerDomainId);
  // last_checked_at decides the next due time against `now()`, so it comes from that clock.
  const now = await dbNow();
  // A provider we couldn't reach gets the timestamp and nothing else: demoting a live domain, or
  // discarding a stored failure reason, on a timeout would be wrong either way.
  const next = providerAnswered(status) ? nextVerificationState(status, domain, now) : null;

  const [row] = await db
    .update(domains)
    .set({
      ...(next ?? {}),
      lastCheckedAt: now,
      updatedAt: now,
    })
    .where(eq(domains.id, domain.id))
    .returning();

  // Only the transition is news — a re-check of an already-verified domain isn't.
  if (row && row.status === "verified" && domain.status !== "verified") {
    await recordActivity({
      organizationId: key.organizationId,
      action: "domain.verified",
      actor: key.actor,
      appliesTo: row.id,
      subjectLabel: row.name,
    });
  }

  const reportUri = await dmarcReportUri(domain);
  const serialized = serializeDomain(row ?? domain, {
    adapter: provider.adapter,
    providerId: provider.id,
    missing: status.missing,
    eventsConfigured,
    reputation: await standingFor(key.organizationId, domain.id),
    reportUri,
  });
  return { ...serialized, dmarc: await checkDmarc(domain.name, (row ?? domain).dnsRecords, reportUri) };
}

export interface DomainPage {
  data: SerializedDomain[];
  next_cursor: string | null;
}

export async function listDomains(
  key: DomainCaller,
  limit: number,
  cursor?: string,
  status?: DomainRow["status"],
  options: { standing?: boolean } = {},
): Promise<DomainPage> {
  // Scoped like every other read here: a foreign id must not become a pagination anchor.
  const after = cursor
    ? await db
        .select({ createdAt: domains.createdAt, id: domains.id })
        .from(domains)
        .where(and(eq(domains.organizationId, key.organizationId), eq(domains.id, cursor)))
        .limit(1)
    : [];
  const edge = after[0];

  const rows = await db
    .select({ domain: domains, provider: providers })
    .from(domains)
    .innerJoin(providers, eq(providers.id, domains.providerId))
    .where(
      and(
        eq(domains.organizationId, key.organizationId),
        key.domainIds.length > 0 ? inArray(domains.id, key.domainIds) : undefined,
        status ? eq(domains.status, status) : undefined,
        edge ? keysetBefore({ table: domains, sort: domains.createdAt, id: domains.id }, edge.id) : undefined,
      ),
    )
    .orderBy(desc(domains.createdAt), desc(domains.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  // One organization-wide read covers every domain on the page.
  const reputation = page.length > 0 && options.standing !== false ? await readOrganizationReputation(key.organizationId, await dbNow()) : null;
  const reportUris = await dmarcReportUris(page.map((row) => row.domain));
  return {
    data: page.map((row) => {
      const standing = reputation?.domains.get(row.domain.id);
      return serializeDomain(row.domain, {
        adapter: row.provider.adapter,
        providerId: row.domain.providerId,
        eventsConfigured: eventsConfiguredFor(row.provider),
        reputation: standing ? { standing: standing.standing, reason: standingReason(standing) } : { standing: "healthy", reason: null },
        reportUri: reportUris.get(row.domain.id) ?? null,
      });
    }),
    next_cursor: rows.length > limit ? (page.at(-1)?.domain.id ?? null) : null,
  };
}

/**
 * Without `standing`, the 7-day read is skipped and the response reads healthy; a caller projects
 * those keys away. With `reputation`, the detail is read once and the standing comes from it.
 * `dmarc` reads the domain's DMARC record live.
 */
export async function readDomain(
  key: DomainCaller,
  id: string,
  options: { standing?: boolean; reputation?: boolean; dmarc?: boolean } = {},
): Promise<SerializedDomain> {
  const domain = await domainFor(key, id);
  const [provider, detail] = await Promise.all([
    loadProvider(key, domain.providerId, "provider_id"),
    options.reputation ? reputationOf(key.organizationId, domain) : null,
  ]);
  const reportUri = await dmarcReportUri(domain);
  const standing = detail
    ? { standing: detail.standing, reason: standingReason(detail) }
    : options.standing === false
      ? { standing: "healthy" as const, reason: null }
      : await standingFor(key.organizationId, domain.id);
  const serialized = serializeDomain(domain, {
    adapter: provider.adapter,
    providerId: provider.id,
    eventsConfigured: eventsConfiguredFor(provider),
    reputation: standing,
    reportUri,
  });
  const withDetail: SerializedDomain = options.dmarc ? { ...serialized, dmarc: await checkDmarc(domain.name, domain.dnsRecords, reportUri) } : serialized;
  if (!options.reputation) return withDetail;
  return { ...withDetail, reputation: detail ? serializeDomainReputation(detail, await dbNow()) : null };
}

/** The reputation detail: windows, reasons, signals, blocklists, provider findings and tenant counts. Null until the domain has verified. */
export async function readDomainReputationDetail(key: DomainCaller, id: string): Promise<DomainReputation | null> {
  return reputationOf(key.organizationId, await domainFor(key, id));
}

/** Field by field: jsonb hands keys back in its own order. */
function sameLayout(a: DomainLayout | null, b: DomainLayout | null): boolean {
  if (!a || !b) return a === b;
  return a.brandName === b.brandName && a.logoUrl === b.logoUrl && a.accent === b.accent && a.footer === b.footer;
}

async function reputationOf(organizationId: string, domain: DomainRow): Promise<DomainReputation | null> {
  return domain.verifiedAt ? readDomainReputation(organizationId, domain.id, await dbNow()) : null;
}

/**
 * Sets, changes or clears the domain's layout. Fields left out of `patch` keep their stored value,
 * and only what it sends is checked. An uploaded logo the change drops is deleted.
 */
export async function setDomainLayout(key: DomainCaller, id: string, patch: LayoutPatch): Promise<void> {
  const domain = await domainFor(key, id);

  let next: DomainLayout | null;
  try {
    next = mergeLayout(domain.layout, patch, domain.name);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const attempted = { ...(domain.layout ? serializeLayout(domain.layout, domain.name) : {}), ...patch };
    throw validationError(new ZodError(error.issues.map((issue) => ({ ...issue, path: ["layout", ...issue.path] }))), {
      layout: attempted,
    });
  }
  if (sameLayout(next, domain.layout)) return;

  await db
    .update(domains)
    .set({ layout: next, updatedAt: await dbNow() })
    .where(and(eq(domains.organizationId, key.organizationId), eq(domains.id, domain.id)));

  const previousLogo = domain.layout?.logoUrl ?? null;
  if (previousLogo && previousLogo !== (next?.logoUrl ?? null)) {
    // After the write, so a failed save never leaves the layout pointing at a deleted file.
    await deleteUploadedLogoIfOurs(domain.id, previousLogo).catch((err) =>
      log.warn(`deleting the old logo for ${domain.name} failed: ${safeErrorMessage(err)}`),
    );
  }

  await recordActivity({
    organizationId: key.organizationId,
    action: "domain.layout.changed",
    actor: key.actor,
    appliesTo: domain.id,
    subjectLabel: domain.name,
    ...(next ? {} : { metadata: { cleared: true } }),
  });
}

/**
 * Whether the adapter's own event plumbing is finished for this provider. Read from settings: a
 * list or a read must not decrypt a provider's credentials to answer a question about them.
 */
function eventsConfiguredFor(provider: ProviderRow): boolean {
  return isConfiguredFor(provider.adapter, provider.settings);
}

/**
 * Drops the domain here and, when the adapter can, at the provider. The row goes inside a
 * transaction that the provider call runs in too, so a restrict foreign key or a provider
 * failure rolls the whole thing back and nothing is half-deleted either side.
 */
export async function deleteDomain(key: DomainCaller, id: string): Promise<{ id: string; deleted: true }> {
  const domain = await domainFor(key, id);
  const provider = await loadProvider(key, domain.providerId, "provider_id");
  const client = adapterFor(provider);

  await db.transaction(async (tx) => {
    const block = await domainDeleteBlock(domain, tx);
    if (block) {
      throw new ApiError("domain_in_use", block.message, {
        detail: block.lists.length > 0 ? { lists: block.lists.map((list) => list.name) } : undefined,
      });
    }

    await dropServiceMail(domain.id, tx);
    await dropDomain(domain, client, tx);
  });

  await recordActivity({
    organizationId: key.organizationId,
    action: "domain.deleted",
    actor: key.actor,
    appliesTo: domain.id,
    subjectLabel: domain.name,
  });

  return { id: domain.id, deleted: true };
}

/**
 * Drops the row and the identity behind it, inside the caller's transaction. The row goes first
 * so the foreign keys, not a check ahead of it, are what decides: a reference added since fails
 * here, before anything at the provider is touched, and a provider failure rolls the delete back.
 */
export async function dropDomain(domain: DomainRow, client: Adapter, tx: Executor): Promise<void> {
  try {
    await tx.delete(domains).where(eq(domains.id, domain.id));
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code === "23503") {
      throw new ApiError("domain_in_use", `Something was added to ${domain.name} while deleting. Try again.`);
    }
    throw err;
  }

  if (domain.pendingProviderId) {
    // A pending move left an identity at the target provider too. Drop it first.
    await removePendingIdentity(domain, tx);
  }

  if (client.domain.remove) {
    try {
      await client.domain.remove(domain.name, domain.providerDomainId);
    } catch (err) {
      throw new ApiError("provider_unavailable", `Provider couldn't remove ${domain.name}: ${safeErrorMessage(err)}`);
    }
  }

  // Last, and never thrown: a rollback past here would leave inbound on with no route behind it.
  // A route left over only brings mail that ingest drops for a domain that no longer exists.
  await closeInboundRoute(domain, client).catch((err) =>
    log.warn(`taking down inbound routing for deleted domain ${domain.name} failed: ${safeErrorMessage(err)}`),
  );
}

/**
 * Drops the identity a pending move created at its target provider, then clears the binding.
 * Throws, leaving the binding, when the provider can't drop it. Exported for the verify loop.
 */
export async function cancelPendingBinding(domain: DomainRow, now: Date): Promise<void> {
  if (!domain.pendingProviderId) return;

  await removePendingIdentity(domain, db);

  await db
    .update(domains)
    .set({
      pendingProviderId: null,
      pendingProviderDomainId: null,
      pendingDnsRecords: [],
      pendingMissingRecords: [],
      pendingStartedAt: null,
      pendingLastCheckedAt: null,
      updatedAt: now,
    })
    .where(eq(domains.id, domain.id));
}

/** Drops the identity a pending move created at its target provider. Throws when the provider can't. */
async function removePendingIdentity(domain: DomainRow, tx: Executor): Promise<void> {
  if (!domain.pendingProviderId) return;

  const [pendingProvider] = await tx
    .select()
    .from(providers)
    .where(eq(providers.id, domain.pendingProviderId))
    .limit(1);
  if (!pendingProvider) return;

  const client = adapterFor(pendingProvider);
  if (!client.domain.remove) return;
  try {
    await client.domain.remove(domain.name, domain.pendingProviderDomainId);
  } catch (err) {
    throw new ApiError(
      "provider_unavailable",
      `Provider couldn't remove the pending domain ${domain.name}: ${(err as Error).message}`,
    );
  }
}

/**
 * Records, replaces or cancels a pending move to another provider. The domain keeps
 * sending on its current provider throughout — this never touches `provider_id`. The
 * worker's verify loop is what cuts a binding over, once it verifies (see worker/verify.ts).
 *
 * `targetProviderId: null` cancels an in-progress move, at no cost: the identity created at the
 * target is dropped and nothing about the live binding changes.
 */
export async function moveDomain(key: DomainCaller, id: string, targetProviderId: string | null): Promise<SerializedDomain> {
  const domain = await domainFor(key, id);

  if (targetProviderId === null) {
    if (domain.pendingProviderId) {
      await cancelPendingBinding(domain, await dbNow());
      await recordActivity({
        organizationId: key.organizationId,
        action: "domain.move.cancelled",
        actor: key.actor,
        appliesTo: domain.id,
        subjectLabel: domain.name,
      });
    }
    return readDomain(key, id);
  }

  if (targetProviderId === domain.pendingProviderId) {
    // Already moving here — nothing to do.
    return readDomain(key, id);
  }

  if (targetProviderId === domain.providerId) {
    throw new ApiError("validation_failed", `${domain.name} already sends through this provider.`, {
      field: "provider_id",
    });
  }

  const provider = await loadProvider(key, targetProviderId, "provider_id");
  const capabilities = capabilitiesOf(provider.adapter);
  const context = { webhookUrl: webhookUrl(provider.adapter, provider.id) };
  // The target has to be able to stand up an identity and answer verification on its own, since
  // that's how the cutover notices the move is done.
  assertCan(capabilities, "domainsViaApi", "add a domain", context);

  const now = await dbNow();
  if (domain.pendingProviderId) {
    // Replacing one move with another: drop the abandoned identity at the old target first.
    await cancelPendingBinding(domain, now);
  }

  const client = adapterFor(provider);
  let created;
  try {
    created = await client.domain.create(domain.name);
  } catch (err) {
    throw providerDomainError(err, provider);
  }
  // Named after the provider, not the domain (#27), so this is a no-op the second time it walks
  // this code path for the same provider rather than a race with the provider's other domains.
  await configureEvents(provider, domain.name, undefined, client);

  await db
    .update(domains)
    .set({
      pendingProviderId: provider.id,
      pendingProviderDomainId: created.providerDomainId,
      pendingDnsRecords: created.records,
      pendingMissingRecords: created.records,
      pendingStartedAt: now,
      pendingLastCheckedAt: null,
      updatedAt: now,
    })
    .where(eq(domains.id, domain.id));

  await recordActivity({
    organizationId: key.organizationId,
    action: "domain.move.started",
    actor: key.actor,
    appliesTo: domain.id,
    subjectLabel: domain.name,
  });

  return readDomain(key, id);
}

/**
 * Turns bulk sending on or off for this domain (#246). Off is always accepted — a false can
 * always win over a capable provider. On is refused outright when the provider can't do bulk
 * at all: that's a fact about the provider, not something an operator's toggle can override. On
 * is also refused while the domain has no valid DMARC record.
 */
export async function setBulkAllowed(key: DomainCaller, id: string, allowed: boolean): Promise<SerializedDomain> {
  const domain = await domainFor(key, id);
  const provider = await loadProvider(key, domain.providerId, "provider_id");

  if (allowed && !capabilitiesOf(provider.adapter).bulk) {
    throw new ApiError("bulk_not_allowed", bulkNotAllowedMessage("provider_incapable", domain.name), {
      detail: { reason: "provider_incapable" },
    });
  }

  if (allowed && !domain.bulkAllowed) {
    // Mailbox providers reject bulk mail from a domain with no DMARC record. A domain already on isn't re-checked.
    const dmarc = await checkDmarc(domain.name, domain.dnsRecords);
    const finding = dmarc.findings[0];
    if (dmarcBlocksBulk(dmarc) && finding) {
      throw new ApiError("bulk_not_allowed", `Can't turn bulk on for ${domain.name}. ${finding.message}`, { detail: { reason: "dmarc_required" } });
    }
  }

  const [row] = await db
    .update(domains)
    .set({ bulkAllowed: allowed, updatedAt: await dbNow() })
    .where(and(eq(domains.organizationId, key.organizationId), eq(domains.id, domain.id)))
    .returning();
  if (!row) throw new ApiError("not_found", `No domain with id ${id}.`);

  if (row.bulkAllowed !== domain.bulkAllowed) {
    await recordActivity({
      organizationId: key.organizationId,
      action: allowed ? "domain.bulk.enabled" : "domain.bulk.disabled",
      actor: key.actor,
      appliesTo: row.id,
      subjectLabel: row.name,
    });
  }

  return serializeDomain(row, {
    adapter: provider.adapter,
    providerId: provider.id,
    eventsConfigured: eventsConfiguredFor(provider),
    reputation: await standingFor(key.organizationId, row.id),
    reportUri: await dmarcReportUri(row),
  });
}

export { serializeDomain };
export type { SerializedDomain };
