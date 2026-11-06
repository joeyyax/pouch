import { groupActivity } from "@/lib/activity/group";
import type { ActivityGroup, ActivityListItem } from "@/lib/activity/types";
import { groupByDay } from "./days";

/** Entries the activity screen shows per page. An entry is one event or one collapsed run. */
export const ACTIVITY_ENTRIES_PER_PAGE = 25;

/** A newest-first list as the timeline renders it: runs collapse within a day, never across midnight. */
export function activityEntriesByDay(items: ActivityListItem[], zone: string): { day: string; groups: ActivityGroup[] }[] {
  return groupByDay(items, (item) => item.createdAt, zone).map((day) => ({ day: day.day, groups: groupActivity(day.items) }));
}
