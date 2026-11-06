import { subjectFallbackLabel } from "@/lib/activity/labels";
import { countedPhraseFor, phraseFor } from "@/lib/activity/taxonomy";
import type { ActivityFamily, ActivityGroup } from "@/lib/activity/types";

type Subject = ActivityGroup["subjects"][number];

/** One piece of a subject list: a named subject, or a count standing in for the unnamed ones. */
export type SubjectPart = { kind: "subject"; subject: Subject } | { kind: "text"; text: string };

export interface SubjectPhrase {
  parts: SubjectPart[];
  /** Named subjects past the ones shown: "and 4 more". */
  more: number;
  /** Whether "×N" adds anything the names don't already say. */
  showCount: boolean;
}

const MAX_NAMED = 3;

const UNNAMED_PLURAL: Partial<Record<ActivityFamily, string>> = {
  suppression: "removed addresses",
};

/** How a run names what it acted on. Unnamed subjects are counted, not repeated. */
export function subjectPhrase(group: Pick<ActivityGroup, "family" | "subjects" | "count">): SubjectPhrase {
  const fallback = subjectFallbackLabel(group.family);
  const named = group.subjects.filter((subject) => subject.label !== fallback);
  const unnamed = group.subjects.length - named.length;
  const shown = named.slice(0, MAX_NAMED);
  const more = named.length - shown.length;

  const parts: SubjectPart[] = shown.map((subject) => ({ kind: "subject", subject }));
  if (unnamed === 1) parts.push({ kind: "text", text: fallback });
  if (unnamed > 1) parts.push({ kind: "text", text: `${unnamed} ${UNNAMED_PLURAL[group.family] ?? "things no longer here"}` });

  const everyOneSaid = group.subjects.length > 0 && group.subjects.length === group.count && more === 0;
  return { parts, more, showCount: group.count > 1 && !everyOneSaid };
}

export interface ActionPhrase {
  text: string;
  /** Complete without the subject list. */
  standalone: boolean;
  /** Whether "×N" adds anything the sentence doesn't already say. */
  showCount: boolean;
}

/** The verb for a run, plural-aware: "removed 3 suppressions" when every subject went unnamed. */
export function actionPhrase(group: Pick<ActivityGroup, "action" | "family" | "subjects" | "count">): ActionPhrase {
  const fallback = subjectFallbackLabel(group.family);
  const unnamed = group.subjects.filter((subject) => subject.label === fallback).length;
  if (unnamed > 1 && unnamed === group.subjects.length) {
    const counted = countedPhraseFor(group.action, unnamed);
    if (counted) return { text: counted, standalone: true, showCount: group.count > unnamed };
  }
  const phrase = phraseFor(group.action, group.subjects.length);
  return { ...phrase, showCount: phrase.standalone ? group.count > 1 : subjectPhrase(group).showCount };
}
