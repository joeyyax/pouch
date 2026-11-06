import { customAlphabet } from "nanoid";
import { and, count, desc, eq, gt, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { keysetBefore } from "@/lib/db/keyset";
import { addresses, apiKeys, domains, organizations, type AddressRow, type AddressStatus } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { assertLiveKey, keyCanAccessDomain, type OrganizationKeyRow } from "@/lib/api/keys";
import { newId } from "@/lib/ids";
import type { CreateAddressRequest, UpdateAddressRequest } from "@/lib/schemas/address";
import { ADDRESS_MAX_TTL_SECONDS, ADDRESS_MIN_TTL_SECONDS, RANDOM_LOCAL_PART_LENGTH } from "./constants";
import { serializeAddress, type AddressDomain, type SerializedAddress } from "./serialize";
import { effectiveAddressLimits, readAddressLimitDefaults } from "./limits";

/** An API key's organization, domain scope and id. */
export interface AddressCaller {
  organizationId: string;
  /** Domains the caller may reach. Empty means every domain. */
  domainIds: string[];
  /** The key creating an address. Its endpoints hear `address.received`. */
  apiKeyId: string | null;
}

/** The caller a key is on every address route. A test key is refused. */
export function addressCallerFor(key: OrganizationKeyRow): AddressCaller {
  assertLiveKey(key, "manage addresses");
  return { organizationId: key.organizationId, domainIds: key.domainIds, apiKeyId: key.id };
}

/** An unrevoked organization key in this organization, which the dashboard creates an address as. */
export async function organizationKeyFor(organizationId: string, keyId: string): Promise<OrganizationKeyRow> {
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.id, keyId), eq(apiKeys.scope, "organization")))
    .limit(1);
  if (!key) throw new ApiError("not_found", `No key with id ${keyId}.`, { field: "key_id" });
  if (key.revokedAt) throw new ApiError("validation_failed", `${key.name} is revoked. Choose a live key.`, { field: "key_id" });
  return key as OrganizationKeyRow;
}

const randomLocalPart = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", RANDOM_LOCAL_PART_LENGTH);

async function domainInScope(caller: AddressCaller, id: string): Promise<typeof domains.$inferSelect> {
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.organizationId, caller.organizationId), eq(domains.id, id)))
    .limit(1);
  if (!domain) throw new ApiError("not_found", `No domain with id ${id}.`, { field: "domain_id" });
  if (!keyCanAccessDomain(caller, domain.id)) throw new ApiError("key_not_scoped", `This key can't reach ${domain.name}.`, { field: "domain_id" });
  return domain;
}

/** The expiry a request asks for, checked against `now`. */
function expiryFrom(input: { expires_at?: string; expires_in?: number }, now: Date): Date | null {
  if (input.expires_in !== undefined) return new Date(now.getTime() + input.expires_in * 1000);
  if (input.expires_at === undefined) return null;
  const at = new Date(input.expires_at);
  const ahead = (at.getTime() - now.getTime()) / 1000;
  if (ahead < ADDRESS_MIN_TTL_SECONDS || ahead > ADDRESS_MAX_TTL_SECONDS) {
    throw new ApiError(
      "validation_failed",
      `Field "expires_at" isn't valid: it has to be between ${ADDRESS_MIN_TTL_SECONDS} seconds and 365 days from now.`,
      { field: "expires_at" },
    );
  }
  return at;
}

/** Active means not revoked and not past its expiry, whatever the sweep has got to. */
function activeAt(now: Date): SQL {
  return and(eq(addresses.status, "active"), gt(addresses.expiresAt, now))!;
}

/** Locks the organization's row, so concurrent creates count active addresses one at a time. */
async function assertRoomForOne(tx: Executor, organizationId: string, now: Date): Promise<void> {
  const defaults = await readAddressLimitDefaults();
  const [org] = await tx
    .select({ addressLimit: organizations.addressLimit, addressDailyMessageLimit: organizations.addressDailyMessageLimit })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update");
  if (!org) throw new ApiError("not_found", `No organization with id ${organizationId}.`);
  const limit = effectiveAddressLimits(org, defaults).active;
  const [row] = await tx
    .select({ active: count() })
    .from(addresses)
    .where(and(eq(addresses.organizationId, organizationId), activeAt(now)));
  if ((row?.active ?? 0) >= limit) {
    throw new ApiError(
      "address_limit_reached",
      `This organization has ${limit} active addresses, its limit. Revoke one or let one expire.`,
      { detail: { limit } },
    );
  }
}

export async function createAddress(caller: AddressCaller, input: CreateAddressRequest): Promise<SerializedAddress> {
  const domain = await domainInScope(caller, input.domain_id);
  if (!domain.inboundEnabled) {
    throw new ApiError("inbound_disabled", `Inbound isn't enabled on ${domain.name}. Enable it with PATCH /v1/domains/${domain.id}/inbound.`, {
      field: "domain_id",
    });
  }

  return db.transaction(async (tx) => {
    const now = await dbNow(tx);
    const expiresAt = expiryFrom(input, now)!;
    await assertRoomForOne(tx, caller.organizationId, now);

    // A random local part that collides is drawn again; a chosen one that collides is refused.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const localPart = input.local_part ?? randomLocalPart();
      const [row] = await tx
        .insert(addresses)
        .values({
          id: newId("address"),
          organizationId: caller.organizationId,
          domainId: domain.id,
          apiKeyId: caller.apiKeyId,
          localPart,
          label: input.label ?? null,
          expiresAt,
          messageCap: input.message_cap ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [addresses.domainId, addresses.localPart] })
        .returning();
      if (row) return serializeAddress(row, domain, now);
      if (input.local_part !== undefined) {
        throw new ApiError("address_exists", `${localPart} is already taken on ${domain.name}.`, { field: "local_part" });
      }
    }
    throw new ApiError("provider_unavailable", "Couldn't find a free local part. Try again.");
  });
}

/** The address and its domain, in the caller's organization and scope. */
export async function addressInScope(executor: Executor, caller: AddressCaller, id: string, lock = false): Promise<{ row: AddressRow; domain: AddressDomain }> {
  const query = executor
    .select({ row: addresses, name: domains.name, inboundSubdomain: domains.inboundSubdomain })
    .from(addresses)
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .where(and(eq(addresses.organizationId, caller.organizationId), eq(addresses.id, id)))
    .limit(1);
  const [found] = lock ? await query.for("update", { of: addresses }) : await query;
  if (!found) throw new ApiError("not_found", `No address with id ${id}.`);
  if (!keyCanAccessDomain(caller, found.row.domainId)) throw new ApiError("key_not_scoped", "This key can't read this address.");
  return { row: found.row, domain: { name: found.name, inboundSubdomain: found.inboundSubdomain } };
}

export async function readAddress(caller: AddressCaller, id: string): Promise<SerializedAddress> {
  const { row, domain } = await addressInScope(db, caller, id);
  return serializeAddress(row, domain, await dbNow());
}

export interface AddressPage {
  data: SerializedAddress[];
  next_cursor: string | null;
}

function statusFilter(status: AddressStatus, now: Date): SQL {
  if (status === "active") return activeAt(now);
  if (status === "expired") return or(eq(addresses.status, "expired"), and(eq(addresses.status, "active"), lte(addresses.expiresAt, now)))!;
  return eq(addresses.status, "revoked");
}

export type AddressStatusCounts = Record<AddressStatus, number>;

/** The organization's addresses by status, as of now. `active` is what `address_limit` counts. */
export async function countAddresses(organizationId: string): Promise<AddressStatusCounts> {
  const now = await dbNow();
  const tally = (status: AddressStatus) => sql<number>`count(*) filter (where ${statusFilter(status, now)})::int`;
  const [row] = await db
    .select({ active: tally("active"), expired: tally("expired"), revoked: tally("revoked") })
    .from(addresses)
    .where(eq(addresses.organizationId, organizationId));
  return { active: row?.active ?? 0, expired: row?.expired ?? 0, revoked: row?.revoked ?? 0 };
}

export async function listAddresses(
  caller: AddressCaller,
  limit: number,
  cursor?: string,
  filters: { domain?: string; status?: AddressStatus } = {},
): Promise<AddressPage> {
  const now = await dbNow();
  const after = cursor
    ? await db
        .select({ id: addresses.id })
        .from(addresses)
        .where(and(eq(addresses.organizationId, caller.organizationId), eq(addresses.id, cursor)))
        .limit(1)
    : [];
  const edge = after[0];

  const rows = await db
    .select({ row: addresses, name: domains.name, inboundSubdomain: domains.inboundSubdomain })
    .from(addresses)
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .where(
      and(
        eq(addresses.organizationId, caller.organizationId),
        caller.domainIds.length > 0 ? inArray(addresses.domainId, caller.domainIds) : undefined,
        filters.domain ? eq(addresses.domainId, filters.domain) : undefined,
        filters.status ? statusFilter(filters.status, now) : undefined,
        edge ? keysetBefore({ table: addresses, sort: addresses.createdAt, id: addresses.id }, edge.id) : undefined,
      ),
    )
    .orderBy(desc(addresses.createdAt), desc(addresses.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return {
    data: page.map(({ row, name, inboundSubdomain }) => serializeAddress(row, { name, inboundSubdomain }, now)),
    next_cursor: rows.length > limit ? (page.at(-1)?.row.id ?? null) : null,
  };
}

/** Moves the expiry, label or cap. Moving an expired address's expiry forward brings it back, within the limit. */
export async function updateAddress(caller: AddressCaller, id: string, patch: UpdateAddressRequest): Promise<SerializedAddress> {
  return db.transaction(async (tx) => {
    const now = await dbNow(tx);
    const expiresAt = expiryFrom(patch, now);
    // The organization's row first, the same order a create locks in.
    const { row: peek } = await addressInScope(tx, caller, id);
    const reviving = expiresAt !== null && peek.status !== "revoked" && (peek.status === "expired" || peek.expiresAt.getTime() <= now.getTime());
    if (reviving) await assertRoomForOne(tx, caller.organizationId, now);

    const { row: current, domain } = await addressInScope(tx, caller, id, true);
    if (current.status === "revoked") throw new ApiError("validation_failed", "A revoked address can't be edited.");

    const [row] = await tx
      .update(addresses)
      .set({
        ...(expiresAt ? { expiresAt, status: "active" as const } : {}),
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.message_cap !== undefined ? { messageCap: patch.message_cap } : {}),
        updatedAt: now,
      })
      .where(eq(addresses.id, current.id))
      .returning();
    return serializeAddress(row!, domain, now);
  });
}

/** Revoking is final: mail to the address drops and counts from here on, and the local part stays taken. */
export async function revokeAddress(caller: AddressCaller, id: string): Promise<SerializedAddress> {
  return db.transaction(async (tx) => {
    const now = await dbNow(tx);
    const { row: current, domain } = await addressInScope(tx, caller, id, true);
    if (current.status === "revoked") return serializeAddress(current, domain, now);
    const [row] = await tx
      .update(addresses)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(eq(addresses.id, current.id))
      .returning();
    return serializeAddress(row!, domain, now);
  });
}
