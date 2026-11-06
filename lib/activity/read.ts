/**
 * The activity log as the API reads it: `GET /v1/activity` and `GET /v1/activity/:id`, and the
 * MCP tools over them. Pages through `listActivity` and `readActivity`, the same reads the
 * Activity screens make. Server-only.
 */
import { ApiError } from "@/lib/api/errors";
import { listActivity, readActivity } from "./query";
import type { ActivityActor, ActivityFamily, ActivityListItem, ActivityOutcome } from "./types";

/** Who is asking. An API key and a dashboard session differ only in scope. */
export interface ActivityCaller {
  organizationId: string;
  /** Domains the caller is limited to. Empty means every domain. */
  domainIds: string[];
}

export interface SerializedActivity {
  id: string;
  action: string;
  family: ActivityFamily;
  outcome: ActivityOutcome;
  actor: ActivityActor;
  applies_to: string | null;
  subject_label: string | null;
  address: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface ActivityRecordPage {
  data: SerializedActivity[];
  next_cursor: string | null;
}

export interface ActivityRecordFilters {
  family?: ActivityFamily[];
  outcome?: ActivityOutcome[];
  actor?: string[];
  since?: Date;
}

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Metadata is stored camelCase; the API names every key snake_case. */
function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [snakeCase(key), snakeKeys(entry)]));
  }
  return value;
}

export function serializeActivity(item: ActivityListItem): SerializedActivity {
  return {
    id: item.id,
    action: item.action,
    family: item.family,
    outcome: item.outcome,
    actor: item.actor,
    applies_to: item.appliesTo,
    subject_label: item.subjectLabel,
    address: item.address,
    metadata: item.metadata ? (snakeKeys(item.metadata) as Record<string, unknown>) : null,
    created_at: item.createdAt.toISOString(),
  };
}

/** The log spans every domain, so a key limited to some can't read it. */
function assertMayRead(caller: ActivityCaller): void {
  if (caller.domainIds.length > 0) {
    throw new ApiError("key_not_scoped", "This key is limited to domains, so it can't read the organization's activity.");
  }
}

export async function listActivityRecords(
  caller: ActivityCaller,
  limit: number,
  cursor: string | undefined,
  filters: ActivityRecordFilters = {},
): Promise<ActivityRecordPage> {
  assertMayRead(caller);
  const page = await listActivity(
    caller.organizationId,
    { families: filters.family ?? [], outcomes: filters.outcome ?? [], actors: filters.actor ?? [], since: filters.since ?? null },
    cursor ? { id: cursor } : null,
    limit,
  );
  return { data: page.rows.map(serializeActivity), next_cursor: page.nextCursor?.id ?? null };
}

export async function readActivityRecord(caller: ActivityCaller, id: string): Promise<SerializedActivity> {
  assertMayRead(caller);
  const item = await readActivity(caller.organizationId, id);
  if (!item) throw new ApiError("not_found", `No activity with id ${id}.`);
  return serializeActivity(item);
}
