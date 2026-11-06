/**
 * Activity log — shared types.
 *
 * Client-safe. This file, `taxonomy.ts`, `filter.ts`, `group.ts` and `labels.ts` hold no
 * database import and may be reached from a "use client" file. `record.ts` and `query.ts`
 * touch Postgres and must not be.
 */
import type { ActivityActorType, ActivityFamily, ActivityOutcome } from "@/lib/db/schema/activity";

export type { ActivityActorType, ActivityFamily, ActivityOutcome };

export interface ActivityActor {
  type: ActivityActorType;
  id: string | null;
  /** Snapshot taken at write time — current name when the row is fresh enough to join it. */
  label: string;
}

/** One row as it comes out of the database, plus what the write side classified it as. */
export interface ActivityListItem {
  id: string;
  action: string;
  family: ActivityFamily;
  outcome: ActivityOutcome;
  actor: ActivityActor;
  appliesTo: string | null;
  subjectLabel: string | null;
  /** Present when the subject still exists, so the row can link to it. */
  subjectHref: string | null;
  /** A list member's address, read live from the row `metadata` names. Null once that row is gone. */
  address: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export type ActivityDetailData = ActivityListItem;

export interface ActivityFilters {
  families: ActivityFamily[];
  outcomes: ActivityOutcome[];
  /** Composite `type:id` (or `type:label` for the worker, which has no id) keys. */
  actors: string[];
  since: Date | null;
}

/** Counted across the window, not the loaded page, so a chip is never offered for an empty result. */
export interface ActivityFacets {
  families: ActivityFamily[];
  outcomes: Record<ActivityOutcome, number>;
}

export interface ActivityActorOption {
  key: string;
  actor: ActivityActor;
}

export interface ActivityCursor {
  createdAt: Date;
  id: string;
}

/** One rendered row: a single event, or a run of the same action by the same actor. */
export interface ActivityGroup {
  id: string;
  action: string;
  family: ActivityFamily;
  outcome: ActivityOutcome;
  actor: ActivityActor;
  /** Distinct subjects, newest first. Empty means the action is organization-wide. */
  subjects: { id: string; label: string; href: string | null }[];
  count: number;
  firstAt: Date;
  lastAt: Date;
  /** The single underlying row, present only when count is 1. */
  single?: ActivityListItem;
}
