/**
 * Every export is an audit record: who, when, what range, how many messages. `recordActivity`
 * is best-effort (docs/decisions.md, "it's an activity log, not an audit log") — a slow or
 * failed write here never blocks the download that's already streaming.
 *
 * Takes an `ActivityActor` rather than a user id/label pair — a dashboard session and an API
 * key both request exports (see /v1/exports) and the actor type has to say which.
 */
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import type { MessageFilters } from "@/lib/messages/filters";
import type { ExportKind } from "@/lib/db/schema/exports";

export type { ExportKind };

export interface ExportAuditInput {
  organizationId: string;
  actor: ActivityActor;
  kind: ExportKind;
  filters?: MessageFilters;
  count: number;
}

export async function recordExport(input: ExportAuditInput): Promise<void> {
  await recordActivity({
    organizationId: input.organizationId,
    action: "system.export.created",
    actor: input.actor,
    metadata: {
      kind: input.kind,
      count: input.count,
      ...(input.filters
        ? {
            domain: input.filters.domain ?? null,
            statuses: input.filters.statuses ?? null,
            tags: input.filters.tags ?? null,
            search: input.filters.search ?? null,
            address: input.filters.address ?? null,
          }
        : {}),
    },
  });
}
