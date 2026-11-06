/**
 * Activity log — phrasing.
 *
 * `phraseFor` lives in taxonomy.ts, next to the action it describes. This adapter turns the
 * rest of a row into small trailing facts and formats the actor and outcome for display.
 * Wording follows docs/product/voice.md: state what happened, name the thing, no synonyms.
 */
import type { ActivityActor, ActivityFamily, ActivityGroup, ActivityOutcome } from "./types";
import { brand } from "@/lib/brand";

export const OUTCOME_LABELS: Record<ActivityOutcome, string> = {
  success: "Succeeded",
  failure: "Failed",
  neutral: "Changed",
};

export type OutcomeTone = "issue" | "good" | "neutral";

export const OUTCOME_TONE: Record<ActivityOutcome, OutcomeTone> = {
  failure: "issue",
  success: "good",
  neutral: "neutral",
};

function asRecord(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return {};
}

/** What `metadata.count` counts, per action. Other actions carry a count that isn't a tally. */
const COUNT_UNITS: Record<string, [string, string]> = {
  "system.retention.swept": ["body", "bodies"],
  "system.abandon.swept": ["message", "messages"],
};

/**
 * Short trailing facts for a row — a before/after value, a reason, a count. Only read from a
 * single row, since a collapsed run has no one answer.
 */
export function detailsFor(group: ActivityGroup): string[] {
  if (!group.single) return [];
  const metadata = asRecord(group.single.metadata);
  const details: string[] = [];

  // List rows name the member by id once its address is gone.
  if (group.single.address) details.push(group.single.address);
  else if (typeof metadata.membershipId === "string") details.push(`member ${metadata.membershipId}`);
  else if (typeof metadata.domainUnsubscribeId === "string") details.push(`domain stop ${metadata.domainUnsubscribeId}`);

  if ("from" in metadata && "to" in metadata) {
    details.push(`${String(metadata.from)} → ${String(metadata.to)}`);
  }
  if (typeof metadata.reason === "string" && metadata.reason) details.push(metadata.reason);
  if (typeof metadata.detail === "string" && metadata.detail) details.push(metadata.detail);
  const countUnit = COUNT_UNITS[group.action];
  if (countUnit && typeof metadata.count === "number") {
    details.push(`${metadata.count} ${metadata.count === 1 ? countUnit[0] : countUnit[1]}`);
  }
  if (typeof metadata.consecutiveFailures === "number") {
    details.push(`${metadata.consecutiveFailures} failed deliveries in a row`);
  }
  if (Array.isArray(metadata.events) && metadata.events.length) {
    details.push((metadata.events as string[]).join(", "));
  }
  if (typeof metadata.adapter === "string" && metadata.adapter) details.push(metadata.adapter);

  return details;
}

const ACTOR_TYPE_LABEL: Record<ActivityActor["type"], string> = {
  user: "",
  admin: "",
  api_key: "API key",
  worker: brand.name,
  provider: "Provider callback",
};

/** The name to render for the actor column — a person's name, or the non-human actor's label. */
export function actorName(actor: ActivityActor): string {
  if (actor.type === "user") return actor.label;
  // The suffix is the point: an admin's write in someone else's organization can't read as theirs.
  if (actor.type === "admin") return `${actor.label} (${brand.name} admin)`;
  if (actor.type === "api_key") return `API key ${actor.label}`;
  return ACTOR_TYPE_LABEL[actor.type] || actor.label;
}

/** Initials for the avatar fallback. Non-human actors get a glyph, not a fake person's initials. */
export function actorInitials(actor: ActivityActor): string {
  if (actor.type !== "user" && actor.type !== "admin") return "";
  const parts = actor.label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/**
 * What a row says when it has no write-time label to fall back on — currently only a
 * suppression, whose address is never snapshotted (see lib/activity/query.ts). Never the
 * raw id: an operator can't act on `sup_xyz`, and it reads like a bug rather than a row
 * whose subject was cleaned up.
 */
const SUBJECT_FALLBACK: Partial<Record<ActivityFamily, string>> = {
  suppression: "a removed address",
};

export function subjectFallbackLabel(family: ActivityFamily): string {
  return SUBJECT_FALLBACK[family] ?? "something no longer here";
}
