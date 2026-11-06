import type { MetricsWindowDays } from "@/lib/metrics/window";
import { BASELINE_DAYS, readVolumeShift, roughly, type VolumeShift } from "./volume";
import { describeStall, STALL_WINDOW_DAYS, type StallDetail, type StallReason } from "@/lib/domains/guard";
import { messagesHref } from "@/lib/messages/link";
import { SIGNAL_WINDOW_HOURS, NEW_DOMAIN_DAYS, type Finding, type Standing } from "@/lib/reputation/standing";
import type { OutcomeCounts } from "./rates";
import { spellDuration } from "./duration";
import { formatNumber } from "@/lib/format/number";
import type { ObservationResult } from "@/lib/observations/_runner";
import type { MuteOffer } from "@/lib/observations/_types";
import type { ObservationKey } from "@/lib/observations/registry.generated";

/**
 * The named conditions the overview reports, each a sentence about what's wrong or, at info tone,
 * what changed. Empty when nothing is. Org-scoped; system-wide causes belong to the system view.
 */

export type ConditionKey =
  | "backlog"
  | "held"
  | "accepted_silent"
  | "domain_reputation"
  | "organization_reputation"
  | "retry_pressure"
  | "domain_volume"
  | "domain_stalled"
  | ObservationKey;

export interface ConditionLink {
  href: string;
  label: string;
}

export interface Condition {
  key: ConditionKey;
  /** What it is. One line, sentence case. */
  title: string;
  /** What it costs, and what to do when there's something to do. */
  body: string;
  /** Where the evidence is, the affected messages first. Empty when no page shows it. */
  links: ConditionLink[];
  tone: ConditionTone;
  /** Set on an observation's condition: what the card can mute it by. */
  mute?: MuteOffer;
}

/** Info is a change worth knowing about, not a problem. */
export type ConditionTone = "danger" | "warning" | "info";

const TONE_ORDER: Record<ConditionTone, number> = { danger: 0, warning: 1, info: 2 };

/** A due message older than this is the service failing to keep up, not a burst. */
export const BACKLOG_MS = 60_000;

/** A held message older than this gets a callout. Held mail doesn't expire. */
export const HELD_LONG_MS = 3_600_000;

/** Handed to the provider this long ago with no word back. */
export const SILENT_MS = 3_600_000;

/**
 * Handed to the provider this long ago with no terminal event: the provider isn't going to
 * report on it now. SES and Mailpace both close out delivery and bounce notifications well
 * inside a day; 24 hours gives real stragglers room without letting a genuinely abandoned send
 * count as silent forever. The abandon sweep (worker/abandon.ts) marks past this point, and the
 * dashboard's own query uses it as a backstop so an unmarked row can't raise the silent
 * condition past this age either.
 */
export const ABANDON_MS = 24 * 60 * 60 * 1000;

/** A rise in mean attempts worth saying out loud. */
export const RETRY_PRESSURE_RISE = 0.25;

export interface DomainWindow {
  domainId: string;
  domainName: string;
  counts: OutcomeCounts;
  /** Set by the stall guard (#94). Null means the domain is sending normally. */
  stall: { reason: StallReason; detail: StallDetail | null } | null;
  /** Queued mail the stall is holding. */
  held?: { count: number; oldestMs: number } | null;
}

export interface ConditionInput {
  /** The window these numbers cover, so a sentence can name it instead of saying "the window". */
  days: MetricsWindowDays;
  /** Age of the oldest message the worker is late to claim. Null when the queue is clear. */
  oldestDueMs: number | null;
  dueCount: number;
  /** Age of the oldest held message. Null when nothing is held. */
  oldestHeldMs: number | null;
  heldCount: number;
  /** A suspension that fails queued mail is in place, so due mail won't send. */
  queueFails: boolean;
  /**
   * Messages handed over and unresolved, past SILENT_MS and within ABANDON_MS. The upper bound
   * lives in the query that produces this (lib/dashboard/metrics.ts): a message the abandon
   * sweep has marked, or one old enough that it would have been, never reaches this count.
   */
  silentCount: number;
  /** Mean attempts among messages that did send, this window and the one before. */
  retryPressure: number;
  previousRetryPressure: number;
  domains: DomainWindow[];
  /** Each domain's last day and the days before it, from `lib/stats/baseline`. */
  volumes: DomainVolumeInput[];
  /** Standing per domain and for the organization, from `lib/reputation`. */
  reputation: ReputationSubjectInput[];
  /** Findings from `lib/observations`, mutes already applied. */
  observations?: ObservationResult[];
}

export interface DomainVolumeInput {
  domainName: string;
  lastDay: number;
  /** Newest first. */
  baseline: number[];
}

export interface ReputationSubjectInput {
  type: "domain" | "organization";
  id: string;
  /** The domain's name. Unused for an organization. */
  name?: string;
  standing: Standing;
  findings: Finding[];
}

export function evaluateConditions(input: ConditionInput): Condition[] {
  const conditions: Condition[] = [];

  if (input.queueFails && input.dueCount > 0) {
    conditions.push({
      key: "backlog",
      title: "Queued mail will fail",
      body: `${count(input.dueCount, "message")} queued while sending is suspended. They fail instead of sending.`,
      links: [{ href: messagesHref({ statuses: ["queued"] }), label: "See queued messages" }],
      tone: "danger",
    });
  } else if (input.oldestDueMs !== null && input.oldestDueMs > BACKLOG_MS) {
    conditions.push({
      key: "backlog",
      title: "Sends are running behind",
      body: `${count(input.dueCount, "message")} due, the oldest for ${spellDuration(input.oldestDueMs)}. They send when the queue clears.`,
      links: [{ href: messagesHref({ statuses: ["queued"] }), label: "See queued messages" }],
      tone: "warning",
    });
  }

  // A stalled domain's callout already names the mail it holds.
  const explained = input.domains.reduce((sum, domain) => sum + (domain.stall && domain.held ? domain.held.count : 0), 0);
  if (input.heldCount > explained && input.oldestHeldMs !== null && input.oldestHeldMs > HELD_LONG_MS) {
    conditions.push({
      key: "held",
      title: `Held mail is ${spellDuration(input.oldestHeldMs)} old`,
      body: `${count(input.heldCount, "message")} held. They send when the hold lifts, however old they are by then.`,
      links: [{ href: messagesHref({ held: true }), label: "See held messages" }],
      tone: "warning",
    });
  }

  if (input.silentCount > 0) {
    conditions.push({
      key: "accepted_silent",
      title: "No response from the provider",
      body: `${count(input.silentCount, "message")} sent over an hour ago and still unresolved.`,
      links: [{ href: messagesHref({ statuses: ["sent"], days: 1 }), label: "See sent messages" }],
      tone: "warning",
    });
  }

  for (const domain of input.domains) {
    if (domain.stall) {
      conditions.push({
        key: "domain_stalled",
        title: `${domain.domainName} is paused`,
        body: `${describeStall(domain.stall.reason, domain.stall.detail)} ${
          domain.held && domain.held.count > 0
            ? `${count(domain.held.count, "queued message")} held, the oldest for ${spellDuration(domain.held.oldestMs)}. Nothing is lost.`
            : "Queued sends are held, not lost."
        } Clear the hold on the domain page once it's safe to resume.`,
        links: [
          { href: messagesHref({ domain: domain.domainName, held: true }), label: "See held messages" },
          { href: `/domains/${domain.domainId}`, label: "See domain" },
        ],
        tone: "danger",
      });
    }
  }

  // A jump big enough to move reputation already has its warning.
  const spiking = new Set(
    input.reputation
      .filter((subject) => (subject.standing === "watch" || subject.standing === "at_risk") && subject.findings[0]?.kind === "volume_spike")
      .map((subject) => subject.name),
  );
  for (const volume of input.volumes) {
    const reading = readVolumeShift(volume.lastDay, volume.baseline);
    if (!reading || (reading.shift === "up" && spiking.has(volume.domainName))) continue;
    const name = volume.domainName;
    conditions.push({
      key: "domain_volume",
      title: VOLUME_TITLE[reading.shift](name),
      body: `${volume.lastDay === 0 ? "None" : formatNumber(volume.lastDay)} sent in the last day, against about ${formatNumber(roughly(reading.average))} a day over the previous ${BASELINE_DAYS} days.`,
      links: [
        reading.shift === "stopped"
          ? { href: messagesHref({ domain: name, days: BASELINE_DAYS + 1 }), label: "See earlier messages" }
          : { href: messagesHref({ domain: name, days: 1 }), label: "See recent messages" },
      ],
      tone: "info",
    });
  }

  const domainNames = new Map(input.domains.map((domain) => [domain.domainId, domain.domainName]));
  for (const subject of input.reputation) {
    if (subject.type === "domain" && subject.name) domainNames.set(subject.id, subject.name);
  }

  // Paused has its own banners: the stall condition and the suspension banner.
  for (const subject of input.reputation) {
    const [finding] = subject.findings;
    if (!finding || (subject.standing !== "watch" && subject.standing !== "at_risk")) continue;
    const domainId = subject.type === "domain" ? subject.id : finding.domainId;
    conditions.push({
      key: subject.type === "domain" ? "domain_reputation" : "organization_reputation",
      title: finding.title,
      body: finding.action,
      links: reputationLinks(finding, domainId, domainId ? domainNames.get(domainId) : undefined),
      tone: subject.standing === "at_risk" ? "danger" : "warning",
    });
  }

  // Rising retries mean the provider is flaking before it's failing.
  if (
    input.previousRetryPressure > 0 &&
    input.retryPressure - input.previousRetryPressure > RETRY_PRESSURE_RISE
  ) {
    conditions.push({
      key: "retry_pressure",
      title: "Retries are up",
      body: `${input.retryPressure.toFixed(2)} attempts per message, up from ${input.previousRetryPressure.toFixed(2)}. The provider is rejecting more first attempts.`,
      links: [{ href: messagesHref({ retried: true, days: input.days }), label: "See retried messages" }],
      tone: "warning",
    });
  }

  for (const observed of input.observations ?? []) {
    conditions.push({ key: observed.key as ObservationKey, ...observed.wording, tone: observed.tone, mute: observed.mute });
  }

  return conditions.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
}

const VOLUME_TITLE: Record<VolumeShift, (name: string) => string> = {
  stopped: (name) => `${name} stopped sending`,
  down: (name) => `${name} is sending less`,
  up: (name) => `${name} is sending more`,
};

const OUTCOME_STATUS = { bounce: "bounced", complaint: "complained" } as const;

/** The messages behind a finding, when some list shows them. */
function evidenceLink(finding: Finding, domain: string | undefined): ConditionLink | null {
  const scope = domain ? { domain } : {};
  if (finding.metric) {
    const status = OUTCOME_STATUS[finding.metric];
    return { href: messagesHref({ ...scope, statuses: [status], days: STALL_WINDOW_DAYS }), label: `See ${status} messages` };
  }
  switch (finding.kind) {
    case "volume_spike":
    case "first_time_recipients":
      return { href: messagesHref({ ...scope, days: Math.ceil(SIGNAL_WINDOW_HOURS / 24) }), label: "See recent messages" };
    case "new_domain_bounces":
      return { href: messagesHref({ ...scope, statuses: ["bounced"], days: NEW_DOMAIN_DAYS }), label: "See bounced messages" };
    case "suppressed_sends":
      return { href: "/suppressions", label: "See suppressions" };
    default:
      return null;
  }
}

function reputationLinks(finding: Finding, domainId: string | undefined, domain: string | undefined): ConditionLink[] {
  const links: ConditionLink[] = [];
  const evidence = evidenceLink(finding, domain);
  if (evidence) links.push(evidence);
  if (domainId) links.push({ href: `/domains/${domainId}/reputation`, label: "See reputation" });
  else if (finding.kind !== "provider_finding") links.push({ href: "/domains", label: "See domains" });
  return links;
}

function count(value: number, noun: string): string {
  return `${formatNumber(value)} ${noun}${value === 1 ? "" : "s"}`;
}
