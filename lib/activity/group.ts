/**
 * Activity log — grouping.
 *
 * A flat list repeats the same sentence until the interesting rows are lost in it. Adjacent
 * rows sharing an action, an actor and an outcome collapse into one: a retention sweep run
 * three times in a minute reads as one row with a count, not three.
 */
import { subjectFallbackLabel } from "./labels";
import { phraseFor } from "./taxonomy";
import type { ActivityGroup, ActivityListItem } from "./types";

/** Largest gap between two rows that still reads as the same burst. */
export const ADJACENT_GAP_MS = 5 * 60_000;

/** Hard cap on a group's span, so a slow trickle never becomes one row. */
export const MAX_SPAN_MS = 60 * 60_000;

function actorKey(item: ActivityListItem): string {
  return `${item.actor.type}:${item.actor.id ?? item.actor.label}`;
}

function joins(bucket: ActivityListItem[], item: ActivityListItem): boolean {
  const head = bucket[0];
  const previous = bucket.at(-1);
  if (!head || !previous) return false;
  if (item.action !== head.action) return false;
  if (item.outcome !== head.outcome) return false;
  if (actorKey(item) !== actorKey(head)) return false;
  // Input is newest first, so time runs backwards through the bucket.
  if (previous.createdAt.getTime() - item.createdAt.getTime() > ADJACENT_GAP_MS) return false;
  if (head.createdAt.getTime() - item.createdAt.getTime() > MAX_SPAN_MS) return false;
  return true;
}

function toGroup(bucket: ActivityListItem[]): ActivityGroup {
  const head = bucket[0];
  if (!head) throw new Error("groupActivity: tried to render a group from an empty bucket");
  const tail = bucket.at(-1) ?? head;

  const subjects: ActivityGroup["subjects"] = [];
  const seen = new Set<string>();
  for (const item of bucket) {
    if (!item.appliesTo || seen.has(item.appliesTo)) continue;
    seen.add(item.appliesTo);
    subjects.push({ id: item.appliesTo, label: item.subjectLabel ?? subjectFallbackLabel(item.family), href: item.subjectHref });
  }

  return {
    id: head.id,
    action: head.action,
    family: head.family,
    outcome: head.outcome,
    actor: head.actor,
    subjects,
    count: bucket.length,
    firstAt: tail.createdAt,
    lastAt: head.createdAt,
    single: bucket.length === 1 ? head : undefined,
  };
}

/** Collapses a newest-first list into rendered rows. A group sits where its most recent row sat. */
export function groupActivity(items: ActivityListItem[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let bucket: ActivityListItem[] = [];

  for (const item of items) {
    if (bucket.length === 0 || joins(bucket, item)) {
      bucket.push(item);
      continue;
    }
    groups.push(toGroup(bucket));
    bucket = [item];
  }
  if (bucket.length) groups.push(toGroup(bucket));
  return groups;
}

/** An action scoped to the whole organization rather than one key or domain — Pouch's "fleet-wide". */
export function isOrganizationWide(group: ActivityGroup): boolean {
  return phraseFor(group.action).standalone || group.subjects.length > 1;
}
