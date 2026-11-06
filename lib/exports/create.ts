/**
 * Decides whether a filtered export (the message log, or bodies) streams synchronously or
 * queues as a worker job — the sync/async split lib/exports/limits.ts's ceilings now draw.
 * Below the ceiling nothing changes from #152: the caller streams the file itself and no row
 * is written. Past it, a row goes into `exports` for worker/exports.ts to build in the
 * background instead of refusing the request.
 *
 * `data` (suppressions and domain config) isn't row-limited — see lib/exports/data.ts — so it
 * has no ceiling here and never queues; its route calls recordExport directly.
 */
import type { ActivityActor } from "@/lib/activity/types";
import type { MessageFilters } from "@/lib/messages/filters";
import type { ExportJobRow, ExportKind } from "@/lib/db/schema/exports";
import { recordExport } from "./audit";
import { EXPORT_MAX_BODIES, EXPORT_MAX_MESSAGES } from "./limits";
import { createExportRecord } from "./records";

export type FilteredExportKind = "log_csv" | "log_ndjson" | "bodies";

const CEILING: Record<FilteredExportKind, number> = {
  log_csv: EXPORT_MAX_MESSAGES,
  log_ndjson: EXPORT_MAX_MESSAGES,
  bodies: EXPORT_MAX_BODIES,
};

export interface DecideExportInput {
  organizationId: string;
  actor: ActivityActor;
  kind: FilteredExportKind;
  filters: MessageFilters;
  /** Already counted by the caller — every existing route counts before deciding what to do. */
  count: number;
}

export type ExportDecision = { queued: false; count: number } | { queued: true; record: ExportJobRow; count: number };

export async function decideExport(input: DecideExportInput): Promise<ExportDecision> {
  const audit = {
    organizationId: input.organizationId,
    actor: input.actor,
    kind: input.kind,
    filters: input.filters,
    count: input.count,
  };

  if (input.count <= CEILING[input.kind]) {
    await recordExport(audit);
    return { queued: false, count: input.count };
  }

  const record = await createExportRecord(audit);
  await recordExport(audit);
  return { queued: true, record, count: input.count };
}

export interface QueueExportInput {
  organizationId: string;
  actor: ActivityActor;
  kind: ExportKind;
  filters?: MessageFilters;
  count: number;
}

/**
 * Always queues, whatever the count. `/v1/exports` uses this rather than `decideExport`: an
 * API caller polls for a result either way, so there's no reason to give it two response
 * shapes (a raw file stream below the ceiling, JSON above it) depending on how much data
 * happened to match. The dashboard keeps the synchronous path — it's a browser download, and
 * only the dashboard has that UX to serve.
 */
export async function queueExport(input: QueueExportInput): Promise<ExportJobRow> {
  const record = await createExportRecord(input);
  await recordExport(input);
  return record;
}
