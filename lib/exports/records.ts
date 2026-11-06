/**
 * Reads and writes on the `exports` table — the row a queued export becomes so the dashboard
 * and `/v1` have something to poll. Creation and the read paths live here; worker/exports.ts
 * owns claiming, completing and expiring a row, since that's the worker's own job loop and
 * this adapter has no business reaching into it.
 */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { exportJobs, type ExportJobRow, type ExportKind } from "@/lib/db/schema/exports";
import type { ActivityActor } from "@/lib/activity/types";
import type { MessageFilters } from "@/lib/messages/filters";
import { newId } from "@/lib/ids";
import { keysetBefore } from "@/lib/db/keyset";

export interface CreateExportInput {
  organizationId: string;
  actor: ActivityActor;
  kind: ExportKind;
  filters?: MessageFilters;
  /** Row count as counted at request time, when the kind supports one. */
  count?: number;
}

export async function createExportRecord(input: CreateExportInput): Promise<ExportJobRow> {
  const [row] = await db
    .insert(exportJobs)
    .values({
      id: newId("export"),
      organizationId: input.organizationId,
      kind: input.kind,
      status: "requested",
      actorType: input.actor.type,
      actorId: input.actor.id,
      actorLabel: input.actor.label,
      filters: input.filters ? (input.filters as unknown as Record<string, unknown>) : null,
      count: input.count ?? null,
    })
    .returning();
  if (!row) throw new Error("insert into exports returned no row");
  return row;
}

/**
 * What a domain-scoped caller may see: message exports held to domains all inside its scope. An
 * organization-wide one, or `data`, reads as not there. Empty `domainIds` means every export.
 */
function withinScope(domainIds: string[]): SQL | undefined {
  if (domainIds.length === 0) return undefined;
  const restricted = sql`coalesce(${exportJobs.filters} -> 'restrictToDomainIds', '[]'::jsonb)`;
  return sql`${exportJobs.kind} <> 'data' and jsonb_array_length(${restricted}) > 0 and ${restricted} <@ ${JSON.stringify(domainIds)}::jsonb`;
}

/** Scoped lookup — an id from another organization, or outside the caller's domains, reads as not found. */
export async function exportRecordFor(organizationId: string, id: string, domainIds: string[] = []): Promise<ExportJobRow | null> {
  const [row] = await db
    .select()
    .from(exportJobs)
    .where(and(eq(exportJobs.organizationId, organizationId), eq(exportJobs.id, id), withinScope(domainIds)))
    .limit(1);
  return row ?? null;
}

export interface ExportPage {
  data: ExportJobRow[];
  nextCursor: string | null;
}

/** The organization's exports, newest first — same keyset-cursor shape every other list uses. */
export async function listExportRecords(organizationId: string, limit: number, cursor?: string, domainIds: string[] = []): Promise<ExportPage> {
  const after = cursor
    ? await db
        .select({ requestedAt: exportJobs.requestedAt, id: exportJobs.id })
        .from(exportJobs)
        .where(and(eq(exportJobs.organizationId, organizationId), eq(exportJobs.id, cursor)))
        .limit(1)
    : [];
  const edge = after[0];

  const rows = await db
    .select()
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.organizationId, organizationId),
        withinScope(domainIds),
        edge ? keysetBefore({ table: exportJobs, sort: exportJobs.requestedAt, id: exportJobs.id }, edge.id) : undefined,
      ),
    )
    .orderBy(desc(exportJobs.requestedAt), desc(exportJobs.id))
    .limit(limit + 1);

  const data = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (data[data.length - 1]?.id ?? null) : null;
  return { data, nextCursor };
}
