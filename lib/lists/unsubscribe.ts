/**
 * Unsubscribing (#7). Three doors: the hosted `/u/:token` page
 * a bulk message's `List-Unsubscribe` header points at, the key-authenticated API routes for an
 * app with its own preferences page, and the branded page a domain's own `unsubscribe_url`
 * redeems through `POST /v1/unsubscribe`. All three end up here.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domainUnsubscribes, domains, lists, listMemberships } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { keyCanAccessDomain } from "@/lib/api/keys";
import { normalizeAddress, isEmailAddress } from "@/lib/addresses";
import { newId } from "@/lib/ids";
import { recordActivity } from "@/lib/activity/record";
import { enqueueDomainScopedWebhookEvent } from "@/lib/webhooks/dispatch";
import { listFor, type ListCaller } from "./index";
import { verifySubjectToken } from "./tokens";

export class InvalidUnsubscribeTokenError extends Error {
  constructor() {
    super("This unsubscribe link is invalid or has expired.");
    this.name = "InvalidUnsubscribeTokenError";
  }
}

async function emitUnsubscribed(organizationId: string, domainId: string, listId: string | null, address: string): Promise<void> {
  await enqueueDomainScopedWebhookEvent(organizationId, {
    eventId: newId("event"),
    eventType: "email.unsubscribed",
    occurredAt: await dbNow(),
    domainId,
    data: { list_id: listId, address, scope: listId ? "list" : "domain" },
  }).catch(() => {});
}

/** Adds an address to the domain-wide stop list and returns the stop's id. Idempotent. */
async function addDomainUnsubscribe(organizationId: string, domainId: string, address: string): Promise<string> {
  const [row] = await db
    .insert(domainUnsubscribes)
    .values({ id: newId("domainUnsubscribe"), organizationId, domainId, address })
    .onConflictDoUpdate({
      target: [domainUnsubscribes.domainId, domainUnsubscribes.address],
      set: { address: sql`excluded.address` },
    })
    .returning({ id: domainUnsubscribes.id });
  if (!row) throw new ApiError("provider_unavailable", "The unsubscribe couldn't be read back.");
  return row.id;
}

/** What a per-membership unsubscribe link names, read without redeeming it. Null when forged or gone. */
export interface UnsubscribeLink {
  address: string;
  listName: string;
  domainId: string;
  domainName: string;
  unsubscribed: boolean;
  domainStopped: boolean;
}

export async function readUnsubscribeToken(token: string): Promise<UnsubscribeLink | null> {
  const membershipId = verifySubjectToken(token, "unsubscribe");
  if (!membershipId) return null;
  const [row] = await db
    .select({ address: listMemberships.address, status: listMemberships.status, listName: lists.name, domainId: lists.domainId, domainName: domains.name })
    .from(listMemberships)
    .innerJoin(lists, eq(lists.id, listMemberships.listId))
    .innerJoin(domains, eq(domains.id, lists.domainId))
    .where(eq(listMemberships.id, membershipId))
    .limit(1);
  if (!row) return null;
  return {
    address: row.address,
    listName: row.listName,
    domainId: row.domainId,
    domainName: row.domainName,
    unsubscribed: row.status === "unsubscribed",
    domainStopped: await isDomainUnsubscribed(row.domainId, row.address),
  };
}

export interface RedeemResult {
  scope: "list" | "domain";
  list_name: string | null;
  domain_name: string;
}

/**
 * Redeems a per-membership token. `scope: "list"` unsubscribes only that membership;
 * `scope: "domain"` additionally stops every list on the domain for that address — the
 * "stop all bulk mail" option. The address is never read from the caller; it's resolved from the
 * membership the token names, which is the whole point of signing by membership id instead.
 */
export async function redeemUnsubscribeToken(token: string, scope: "list" | "domain"): Promise<RedeemResult> {
  const membershipId = verifySubjectToken(token, "unsubscribe");
  if (!membershipId) throw new InvalidUnsubscribeTokenError();

  const [row] = await db
    .select({
      membershipId: listMemberships.id,
      organizationId: listMemberships.organizationId,
      address: listMemberships.address,
      listId: listMemberships.listId,
      listName: lists.name,
      domainId: lists.domainId,
      domainName: domains.name,
    })
    .from(listMemberships)
    .innerJoin(lists, eq(lists.id, listMemberships.listId))
    .innerJoin(domains, eq(domains.id, lists.domainId))
    .where(eq(listMemberships.id, membershipId))
    .limit(1);
  if (!row) throw new InvalidUnsubscribeTokenError();

  const now = await dbNow();
  await db
    .update(listMemberships)
    .set({ status: "unsubscribed", unsubscribedAt: now, updatedAt: now })
    .where(eq(listMemberships.id, row.membershipId));
  await emitUnsubscribed(row.organizationId, row.domainId, row.listId, row.address);

  if (scope === "domain") {
    await addDomainUnsubscribe(row.organizationId, row.domainId, row.address);
    await emitUnsubscribed(row.organizationId, row.domainId, null, row.address);
    return { scope: "domain", list_name: null, domain_name: row.domainName };
  }

  return { scope: "list", list_name: row.listName, domain_name: row.domainName };
}

/** `POST /v1/lists/:id/unsubscribe { address }` — key-authenticated, for an app's own UI. */
export async function unsubscribeFromList(caller: ListCaller, listId: string, address: string): Promise<{ address: string }> {
  const list = await listFor(caller, listId);
  const normalized = normalizeAddress(address);
  if (!isEmailAddress(normalized)) {
    throw new ApiError("validation_failed", `"${address}" isn't a valid address.`, { field: "address" });
  }

  const now = await dbNow();
  const [membership] = await db
    .insert(listMemberships)
    .values({
      id: newId("listMembership"),
      organizationId: caller.organizationId,
      listId: list.id,
      address: normalized,
      status: "unsubscribed",
      source: "manual",
      doubleOptIn: list.doubleOptIn,
      unsubscribedAt: now,
    })
    .onConflictDoUpdate({
      target: [listMemberships.listId, listMemberships.address],
      set: { status: "unsubscribed", unsubscribedAt: now, updatedAt: now },
    })
    .returning({ id: listMemberships.id });

  await emitUnsubscribed(caller.organizationId, list.domainId, list.id, normalized);
  await recordActivity({
    organizationId: caller.organizationId,
    action: "list.unsubscribed",
    actor: caller.actor,
    appliesTo: list.id,
    subjectLabel: list.name,
    metadata: { membershipId: membership?.id },
  });

  return { address: normalized };
}

/** Loads a domain in the caller's organization and scope. Reads `domains` directly — see lib/lists/index.ts. */
async function domainFor(caller: ListCaller, id: string): Promise<{ id: string; name: string }> {
  const [domain] = await db
    .select({ id: domains.id, name: domains.name })
    .from(domains)
    .where(and(eq(domains.organizationId, caller.organizationId), eq(domains.id, id)))
    .limit(1);
  if (!domain) throw new ApiError("not_found", `No domain with id ${id}.`);
  if (!keyCanAccessDomain(caller, domain.id)) {
    throw new ApiError("key_not_scoped", `This key can't reach this domain.`);
  }
  return domain;
}

/** `POST /v1/domains/:id/unsubscribe { address }` — stops every list on the domain. */
export async function unsubscribeFromDomain(caller: ListCaller, domainId: string, address: string): Promise<{ address: string }> {
  const domain = await domainFor(caller, domainId);
  const normalized = normalizeAddress(address);
  if (!isEmailAddress(normalized)) {
    throw new ApiError("validation_failed", `"${address}" isn't a valid address.`, { field: "address" });
  }

  const domainUnsubscribeId = await addDomainUnsubscribe(caller.organizationId, domain.id, normalized);

  const domainLists = await db.select({ id: lists.id }).from(lists).where(eq(lists.domainId, domain.id));
  if (domainLists.length > 0) {
    const now = await dbNow();
    await db
      .update(listMemberships)
      .set({ status: "unsubscribed", unsubscribedAt: now, updatedAt: now })
      .where(
        and(
          eq(listMemberships.address, normalized),
          inArray(
            listMemberships.listId,
            domainLists.map((l) => l.id),
          ),
        ),
      );
  }

  await emitUnsubscribed(caller.organizationId, domain.id, null, normalized);
  await recordActivity({
    organizationId: caller.organizationId,
    action: "domain.unsubscribed",
    actor: caller.actor,
    appliesTo: domain.id,
    subjectLabel: domain.name,
    metadata: { domainUnsubscribeId },
  });

  return { address: normalized };
}

/** Whether the address is blocked from every list on this domain — checked by batch send. */
/** Which of `addresses` unsubscribed from the domain, normalized, in one query per thousand. */
export async function domainUnsubscribedAmong(domainId: string, addresses: string[]): Promise<Set<string>> {
  const normalized = [...new Set(addresses.map(normalizeAddress))];
  const found = new Set<string>();
  for (let i = 0; i < normalized.length; i += 1000) {
    const rows = await db
      .select({ address: domainUnsubscribes.address })
      .from(domainUnsubscribes)
      .where(and(eq(domainUnsubscribes.domainId, domainId), inArray(domainUnsubscribes.address, normalized.slice(i, i + 1000))));
    for (const row of rows) found.add(row.address);
  }
  return found;
}

export async function isDomainUnsubscribed(domainId: string, address: string): Promise<boolean> {
  const [row] = await db
    .select({ id: domainUnsubscribes.id })
    .from(domainUnsubscribes)
    .where(and(eq(domainUnsubscribes.domainId, domainId), eq(domainUnsubscribes.address, normalizeAddress(address))))
    .limit(1);
  return Boolean(row);
}
