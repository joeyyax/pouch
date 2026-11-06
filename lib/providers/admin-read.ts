/** Admin reads of providers and organizations. Never decrypts credentials. */
import { readAddressLimitDefaults } from "@/lib/addresses/limits";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, organizations, providers, type OrganizationRow } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { keysetBefore } from "@/lib/db/keyset";
import { readProviderRecord, type StoredProviderRecord } from "@/lib/health/checks";
import { readDefaultProviderId } from "@/lib/settings/service";
import { quotaShare, readQuotas } from "./provider-metrics";
import type { ProviderRow } from "./index";
import {
  serializeAdminProvider,
  serializeAdminOrganization,
  serializeAssignment,
  type AdminProvider,
  type AdminAssignment,
  type AdminOrganization,
} from "./admin-serialize";

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

/** A provider an admin manages: a shared provider, or a row that isn't an assignment. */
export async function adminProviderRow(id: string): Promise<ProviderRow> {
  const [row] = await db
    .select()
    .from(providers)
    .where(and(eq(providers.id, id), isNull(providers.sharedProviderId)))
    .limit(1);
  if (!row) throw new ApiError("not_found", `No provider with id ${id}.`, { field: "id" });
  return row;
}

/** Everything a provider row is judged against, loaded once for a set of rows. */
export interface ProviderContext {
  health: Map<string, StoredProviderRecord | null>;
  quotaShare: Map<string, number | null>;
  organizationCount: Map<string, number>;
  defaultProviderId: string | null;
  now: number;
}

/**
 * The health, quota, default-provider and assignment-count reads every admin view of a provider
 * needs. One place, so a new input to that judgement lands once — see docs/decisions.md.
 */
export async function providerContext(rows: ProviderRow[], options: { health?: boolean } = {}): Promise<ProviderContext> {
  const ids = rows.map((row) => row.id);
  const sharedIds = rows.filter((row) => row.shared).map((row) => row.id);
  const withHealth = options.health !== false;
  const [counts, health, quotas, defaultProviderId] = await Promise.all([
    sharedIds.length === 0
      ? []
      : db
          .select({ id: providers.sharedProviderId, count: sql<number>`count(*)::int` })
          .from(providers)
          .where(inArray(providers.sharedProviderId, sharedIds))
          .groupBy(providers.sharedProviderId),
    withHealth ? Promise.all(ids.map((id) => readProviderRecord(id))) : [],
    withHealth ? readQuotas(ids) : new Map<string, never>(),
    readDefaultProviderId(),
  ]);
  const countBy = new Map(counts.map((entry) => [entry.id, entry.count]));
  return {
    health: new Map(rows.map((row, index) => [row.id, health[index] ?? null])),
    quotaShare: new Map(rows.map((row) => [row.id, quotas.has(row.id) ? quotaShare(quotas.get(row.id)!) : null])),
    organizationCount: new Map(rows.map((row) => [row.id, row.shared ? (countBy.get(row.id) ?? 0) : 1])),
    defaultProviderId,
    now: Date.now(),
  };
}

/** Without `health`, the health records and quotas aren't read; status, issues and health then mean nothing and a caller projects them away. */
async function serializeProviders(rows: ProviderRow[], options: { health?: boolean } = {}): Promise<AdminProvider[]> {
  if (rows.length === 0) return [];
  const context = await providerContext(rows, options);
  return rows.map((row) =>
    serializeAdminProvider(row, {
      organizationCount: context.organizationCount.get(row.id) ?? 1,
      defaultProviderId: context.defaultProviderId,
      health: context.health.get(row.id) ?? null,
      quotaShare: context.quotaShare.get(row.id) ?? null,
      now: context.now,
    }),
  );
}

export async function readAdminProvider(id: string, options: { health?: boolean } = {}): Promise<AdminProvider> {
  const [provider] = await serializeProviders([await adminProviderRow(id)], options);
  return provider!;
}

function pageFrom<T extends { id: string }>(items: T[], limit: number, cursor: string | undefined, field = "cursor"): Page<T> {
  let start = 0;
  if (cursor) {
    const at = items.findIndex((item) => item.id === cursor);
    if (at < 0) throw new ApiError("validation_failed", `Field "${field}" doesn't name an item in this list.`, { field });
    start = at + 1;
  }
  const page = items.slice(start, start + limit);
  return { data: page, next_cursor: start + limit < items.length ? (page.at(-1)?.id ?? null) : null };
}

/**
 * Every provider, newest first. Status needs each provider's health record, so the list is
 * built whole and paged in memory; admins hold tens of providers, not thousands.
 */
export async function listAdminProviders(options: {
  limit: number;
  cursor?: string;
  status?: "attention";
  health?: boolean;
}): Promise<Page<AdminProvider>> {
  const rows = await db
    .select()
    .from(providers)
    .where(isNull(providers.sharedProviderId))
    .orderBy(desc(providers.createdAt), desc(providers.id));
  // The attention filter reads status, so it loads health whatever the response returns.
  let items = await serializeProviders(rows, { health: options.health !== false || options.status === "attention" });
  if (options.status === "attention") items = items.filter((provider) => provider.status !== "ready");
  return pageFrom(items, options.limit, options.cursor);
}

async function domainCounts(providerIds: string[]): Promise<Map<string, number>> {
  if (providerIds.length === 0) return new Map();
  const rows = await db
    .select({ id: domains.providerId, count: sql<number>`count(*)::int` })
    .from(domains)
    .where(inArray(domains.providerId, providerIds))
    .groupBy(domains.providerId);
  return new Map(rows.map((row) => [row.id, row.count]));
}

/** The organizations a provider serves: its assignment rows, or the one organization a single provider lives in. */
export async function listProviderAssignments(providerId: string, options: { limit: number; cursor?: string }): Promise<Page<AdminAssignment>> {
  const provider = await adminProviderRow(providerId);

  let rows: ProviderRow[];
  let next: string | null = null;
  if (provider.shared) {
    if (options.cursor) {
      const [edge] = await db
        .select({ id: providers.id })
        .from(providers)
        .where(and(eq(providers.id, options.cursor), eq(providers.sharedProviderId, provider.id)))
        .limit(1);
      if (!edge) throw new ApiError("validation_failed", `Field "cursor" doesn't name an assignment on this provider.`, { field: "cursor" });
    }
    const found = await db
      .select()
      .from(providers)
      .where(
        and(
          eq(providers.sharedProviderId, provider.id),
          options.cursor
            ? keysetBefore({ table: providers, sort: providers.createdAt, id: providers.id }, options.cursor)
            : undefined,
        ),
      )
      .orderBy(desc(providers.createdAt), desc(providers.id))
      .limit(options.limit + 1);
    rows = found.slice(0, options.limit);
    if (found.length > options.limit) next = rows.at(-1)?.id ?? null;
  } else {
    if (options.cursor) return { data: [], next_cursor: null };
    rows = [provider];
  }
  if (rows.length === 0) return { data: [], next_cursor: null };

  const [orgs, counts] = await Promise.all([
    db
      .select()
      .from(organizations)
      .where(inArray(organizations.id, [...new Set(rows.flatMap((row) => (row.organizationId === null ? [] : [row.organizationId])))])),
    domainCounts(rows.map((row) => row.id)),
  ]);
  const orgBy = new Map(orgs.map((org) => [org.id, org]));
  const now = Date.now();
  const data = rows.flatMap((row) => {
    const org = row.organizationId === null ? undefined : orgBy.get(row.organizationId);
    if (!org) return [];
    const parentBackoff = provider.shared ? provider.backoffUntil : null;
    return [serializeAssignment(row, org, counts.get(row.id) ?? 0, parentBackoff, now)];
  });
  return { data, next_cursor: next };
}

/** Without `counts`, assignment_count and domain_count read 0 and a caller projects them away. */
async function serializeOrganizations(orgs: OrganizationRow[], options: { counts?: boolean } = {}): Promise<AdminOrganization[]> {
  if (orgs.length === 0) return [];
  const ids = orgs.map((org) => org.id);
  const defaults = orgs.flatMap((org) => (org.providerId ? [org.providerId] : []));
  const withCounts = options.counts !== false;
  const [assignments, domainRows, defaultRows, limitDefaults] = await Promise.all([
    withCounts
      ? db
          .select({ id: providers.organizationId, count: sql<number>`count(*)::int` })
          .from(providers)
          .where(and(inArray(providers.organizationId, ids), eq(providers.shared, false)))
          .groupBy(providers.organizationId)
      : [],
    withCounts
      ? db
          .select({ id: domains.organizationId, count: sql<number>`count(*)::int` })
          .from(domains)
          .where(inArray(domains.organizationId, ids))
          .groupBy(domains.organizationId)
      : [],
    defaults.length === 0
      ? []
      : db
          .select({ id: providers.id, sharedProviderId: providers.sharedProviderId })
          .from(providers)
          .where(inArray(providers.id, defaults)),
    readAddressLimitDefaults(),
  ]);
  const assignmentBy = new Map(assignments.map((row) => [row.id, row.count]));
  const domainBy = new Map(domainRows.map((row) => [row.id, row.count]));
  const providerBy = new Map(defaultRows.map((row) => [row.id, row.sharedProviderId ?? row.id]));
  return orgs.map((org) =>
    serializeAdminOrganization(org, {
      managedProviderId: org.providerId ? (providerBy.get(org.providerId) ?? null) : null,
      assignmentCount: assignmentBy.get(org.id) ?? 0,
      domainCount: domainBy.get(org.id) ?? 0,
      limitDefaults,
    }),
  );
}

export async function readAdminOrganization(id: string, options: { counts?: boolean } = {}): Promise<AdminOrganization> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  if (!org) throw new ApiError("not_found", `No organization with id ${id}.`, { field: "id" });
  const [serialized] = await serializeOrganizations([org], options);
  return serialized!;
}

/** Every organization, newest first. */
export async function listAdminOrganizations(options: { limit: number; cursor?: string; counts?: boolean }): Promise<Page<AdminOrganization>> {
  if (options.cursor) {
    const [edge] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, options.cursor)).limit(1);
    if (!edge) throw new ApiError("validation_failed", `Field "cursor" doesn't name an organization.`, { field: "cursor" });
  }
  const rows = await db
    .select()
    .from(organizations)
    .where(
      options.cursor
        ? keysetBefore({ table: organizations, sort: organizations.createdAt, id: organizations.id }, options.cursor)
        : undefined,
    )
    .orderBy(desc(organizations.createdAt), desc(organizations.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  return {
    data: await serializeOrganizations(page, { counts: options.counts }),
    next_cursor: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
