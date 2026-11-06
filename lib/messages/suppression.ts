import { and, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { messages, suppressions } from "@/lib/db/schema";
import type { SuppressionRow } from "@/lib/db/schema";
import { isEmailAddress, normalizeAddress } from "@/lib/addresses";
import { ApiError } from "@/lib/api/errors";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { newId } from "@/lib/ids";
import { keysetBefore } from "@/lib/db/keyset";
import { indexSuppressions, unindexSuppressions } from "@/lib/search";

/** Returns the suppressed recipients among the given addresses, matched on the normalized form. Null reads the service's own list. */
export async function findSuppressed(organizationId: string | null, addresses: string[]): Promise<SuppressionRow[]> {
  const normalized = [...new Set(addresses.map(normalizeAddress))];
  if (normalized.length === 0) return [];
  return db
    .select()
    .from(suppressions)
    .where(
      and(
        organizationId === null ? isNull(suppressions.organizationId) : eq(suppressions.organizationId, organizationId),
        inArray(suppressions.address, normalized),
      ),
    );
}

export interface SuppressInput {
  /** Null adds to the service's own list. */
  organizationId: string | null;
  address: string;
  reason: SuppressionRow["reason"];
  detail?: string | null;
  bounceType?: string | null;
  sourceMessageId?: string | null;
}

/** Adds an address to the list. Returns false when it was already on it. */
export async function suppress(input: SuppressInput, executor: Executor = db): Promise<boolean> {
  const inserted = await executor
    .insert(suppressions)
    .values({
      id: newId("suppression"),
      organizationId: input.organizationId,
      address: normalizeAddress(input.address),
      reason: input.reason,
      detail: input.detail ?? null,
      bounceType: input.bounceType ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
    })
    .onConflictDoNothing()
    .returning();
  indexSuppressions(inserted);
  return inserted.length > 0;
}

/** Removes an address, matched on the same normalized form the insert used. */
export async function unsuppress(
  organizationId: string,
  address: string,
  executor: Executor = db,
): Promise<boolean> {
  const removed = await executor
    .delete(suppressions)
    .where(
      and(eq(suppressions.organizationId, organizationId), eq(suppressions.address, normalizeAddress(address))),
    )
    .returning({ id: suppressions.id });
  unindexSuppressions(removed.map((row) => row.id));
  return removed.length > 0;
}

/** Suppressions apply to every domain, so only a key with no domain scope reads or writes them. */
export function requireUnscopedKey(key: { domainIds: string[] }): void {
  if (key.domainIds.length > 0) {
    throw new ApiError("key_not_scoped", "This key is scoped to specific domains and can't manage the organization's suppressions.");
  }
}

export interface SerializedSuppression {
  id: string;
  address: string;
  reason: SuppressionRow["reason"];
  detail: string | null;
  bounce_type: string | null;
  source: string | null;
  source_message_id: string | null;
  created_at: string;
}

export function serializeSuppression(row: SuppressionRow): SerializedSuppression {
  return {
    id: row.id,
    address: row.address,
    reason: row.reason,
    detail: row.detail,
    bounce_type: row.bounceType,
    source: row.source,
    source_message_id: row.sourceMessageId,
    created_at: row.createdAt.toISOString(),
  };
}

export interface SuppressionListOptions {
  limit: number;
  cursor?: string | undefined;
  reason?: SuppressionRow["reason"] | undefined;
  address?: string | undefined;
  /** Domain id of the message that caused it. */
  domain?: string | undefined;
  since?: Date | undefined;
  until?: Date | undefined;
}

/** The filters every surface's suppression list shares, beyond the organization itself. */
export function suppressionFilters(options: {
  reason?: SuppressionRow["reason"] | undefined;
  domainId?: string | undefined;
  since?: Date | undefined;
  until?: Date | undefined;
}): SQL[] {
  const filters: SQL[] = [];
  if (options.reason) filters.push(eq(suppressions.reason, options.reason));
  if (options.since) filters.push(gte(suppressions.createdAt, options.since));
  if (options.until) filters.push(lte(suppressions.createdAt, options.until));
  if (options.domainId) {
    filters.push(
      sql`exists (select 1 from ${messages} where ${messages.id} = ${suppressions.sourceMessageId} and ${messages.domainId} = ${options.domainId})`,
    );
  }
  return filters;
}

/** One suppression by id or by address, matched on its normalized form. */
export async function readSuppression(organizationId: string, idOrAddress: string): Promise<SuppressionRow | null> {
  const [row] = await db
    .select()
    .from(suppressions)
    .where(
      and(
        eq(suppressions.organizationId, organizationId),
        idOrAddress.includes("@")
          ? eq(suppressions.address, normalizeAddress(idOrAddress))
          : eq(suppressions.id, idOrAddress),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** One page, newest first, keyed on `created_at` then id. An unknown cursor starts from the top. */
export async function listSuppressionPage(
  organizationId: string,
  options: SuppressionListOptions,
): Promise<{ data: SuppressionRow[]; nextCursor: string | null }> {
  const [edge] = options.cursor
    ? await db
        .select({ id: suppressions.id })
        .from(suppressions)
        .where(and(eq(suppressions.organizationId, organizationId), eq(suppressions.id, options.cursor)))
        .limit(1)
    : [];

  const rows = await db
    .select()
    .from(suppressions)
    .where(
      and(
        eq(suppressions.organizationId, organizationId),
        ...suppressionFilters({ reason: options.reason, domainId: options.domain, since: options.since, until: options.until }),
        options.address ? eq(suppressions.address, normalizeAddress(options.address)) : undefined,
        edge ? keysetBefore({ table: suppressions, sort: suppressions.createdAt, id: suppressions.id }, edge.id) : undefined,
      ),
    )
    .orderBy(desc(suppressions.createdAt), desc(suppressions.id))
    .limit(options.limit + 1);

  const data = rows.slice(0, options.limit);
  const next = rows.length > options.limit ? data[data.length - 1] : undefined;
  return { data, nextCursor: next?.id ?? null };
}

export interface SuppressionImportRow {
  address: string;
  reason?: SuppressionRow["reason"] | undefined;
  detail?: string | null | undefined;
  source?: string | null | undefined;
  /** 1-based line in an uploaded file. */
  line?: number | undefined;
}

export interface SuppressionImportError {
  /** Null for a JSON import. */
  line: number | null;
  address: string;
  message: string;
}

export interface SuppressionImportResult {
  added: number;
  already_present: number;
  invalid: number;
  errors: SuppressionImportError[];
}

export interface ImportSuppressionsInput {
  organizationId: string;
  rows: SuppressionImportRow[];
  reason: SuppressionRow["reason"];
  source: string;
  actor: ActivityActor;
  /** Structural errors found before these rows were built, such as a CSV row with no address. */
  errors?: SuppressionImportError[];
}

const INSERT_CHUNK = 1000;
export const SUPPRESSION_DETAIL_MAX = 1000;

/**
 * Adds every valid row in one transaction. An address already on the list keeps its row
 * untouched, and so does a repeat within the same import. An invalid row is reported, not fatal.
 */
export async function importSuppressions(input: ImportSuppressionsInput): Promise<SuppressionImportResult> {
  const errors = [...(input.errors ?? [])];
  const seen = new Set<string>();
  const values: (typeof suppressions.$inferInsert)[] = [];
  let repeated = 0;

  for (const row of input.rows) {
    const address = normalizeAddress(row.address);
    const line = row.line ?? null;
    if (!isEmailAddress(address)) {
      errors.push({ line, address: row.address, message: `"${row.address}" isn't a valid address.` });
      continue;
    }
    const detail = row.detail?.trim() || null;
    if (detail && detail.length > SUPPRESSION_DETAIL_MAX) {
      errors.push({ line, address, message: `Detail is longer than ${SUPPRESSION_DETAIL_MAX} characters.` });
      continue;
    }
    if (seen.has(address)) {
      repeated++;
      continue;
    }
    seen.add(address);
    values.push({
      id: newId("suppression"),
      organizationId: input.organizationId,
      address,
      reason: row.reason ?? input.reason,
      detail,
      source: row.source?.trim() || input.source,
    });
  }

  let added = 0;
  const imported: Parameters<typeof indexSuppressions>[0] = [];
  if (values.length > 0) {
    await db.transaction(async (tx) => {
      for (let i = 0; i < values.length; i += INSERT_CHUNK) {
        const inserted = await tx
          .insert(suppressions)
          .values(values.slice(i, i + INSERT_CHUNK))
          .onConflictDoNothing()
          .returning({
            id: suppressions.id,
            organizationId: suppressions.organizationId,
            address: suppressions.address,
            createdAt: suppressions.createdAt,
          });
        added += inserted.length;
        imported.push(...inserted);
      }
    });
  }

  indexSuppressions(imported);

  errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  const result: SuppressionImportResult = {
    added,
    already_present: values.length - added + repeated,
    invalid: errors.length,
    errors,
  };

  if (added > 0) {
    await recordActivity({
      organizationId: input.organizationId,
      action: "suppression.imported",
      actor: input.actor,
      metadata: { added, already_present: result.already_present, invalid: result.invalid, source: input.source },
    });
  }
  return result;
}
