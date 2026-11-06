import type { ConditionLink, ConditionTone } from "@/lib/metrics/conditions";

/** What a mute can name besides the whole organization. */
export type MuteKind = "tag" | "key";

/** What a finding is about, as far as a mute reaches. Numbers and subjects only, never prose. */
export interface Finding {
  tags: string[];
  keyIds: string[];
}

/** A tag's live sends in the last 24 hours and each of the days before, newest first. */
export interface TagVolume {
  tag: string;
  lastDay: number;
  baseline: number[];
  /** Domains that carried the tag in the baseline, and whether each sent any live mail in the last day. */
  baselineDomains: { domainId: string; sending: boolean }[];
}

export interface ObservationContext {
  organizationId: string;
  now: Date;
  /** This observation's tag and key mutes, for one that leaves muted messages out of its own query. */
  mutes: { tags: string[]; keyIds: string[] };
  /** Per-tag daily counts, read once per run and shared. */
  tagVolumes(): Promise<TagVolume[]>;
}

export interface ObservationWording {
  title: string;
  body: string;
  links: ConditionLink[];
}

/** A digest line about one organization. The digest prefixes the organization's name. */
export interface ObservationDigestLine {
  text: string;
  /** A dashboard path inside the organization. */
  path: string;
}

/** How a finding is emailed to owners: what it's about, for the throttle, and its wording. */
export interface ObservationNotice {
  /** Each subject the throttle holds. One mail covers them all and goes while any is new. */
  about: string[];
  /** Names no recipient address, since the mail is kept in Admin's service mail log. */
  wording: ObservationWording;
}

/** What the overview card can offer to mute a finding by. */
export interface MuteOffer {
  observation: string;
  /** The observation's name, for "Turn off". */
  title: string;
  tags: string[];
  keys: { id: string; name: string }[];
}

/** A pattern in send metadata. One file in `lib/observations/` exports one or more. */
export interface Observation<F extends Finding = Finding, K extends string = string> {
  key: K;
  /** The name settings shows. */
  title: string;
  /** One line under the name in settings. */
  description: string;
  tone: ConditionTone;
  mutableBy: readonly MuteKind[];
  /** A typical finding. The registry test words it for both surfaces. */
  example: F;
  evaluate(context: ObservationContext): Promise<F[]>;
  condition(finding: F): ObservationWording;
  digestLine(finding: F): ObservationDigestLine;
  /** Present when owners are emailed about it, through the notification type of the same key. */
  notice?(finding: F): ObservationNotice;
}

export function defineObservation<const K extends string, F extends Finding>(observation: Observation<F, K>): Observation<F, K> {
  return observation;
}

export function isObservation(value: unknown): value is Observation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Observation>;
  return (
    typeof candidate.key === "string" &&
    typeof candidate.evaluate === "function" &&
    typeof candidate.condition === "function" &&
    typeof candidate.digestLine === "function"
  );
}

/** The observations a module exports. */
export type ExportedObservations<M> = Extract<M[keyof M], Observation>;
