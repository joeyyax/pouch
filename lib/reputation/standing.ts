/**
 * Reputation standing: one status per domain and per organization, from the same counts the stall
 * guard reads. Pure, so every line is testable. Nothing here pauses sending; the stall guard and
 * org suspension stay the only actors.
 */
import { describeStall, evaluateStall, projectsPast, STALL_WINDOW_DAYS, type StallLines, type StallMetric } from "@/lib/domains/guard";
import { formatRate, rate, RATE_FLOOR, rateDelta, resolved, type OutcomeCounts } from "@/lib/metrics/rates";
import { BLOCKLIST_INFO, type BlocklistId } from "@/lib/blocklists/lists";
import { formatNumber } from "@/lib/format/number";
import { describeDeliveryShift, shiftMultiple, type DeliveryShift } from "@/lib/metrics/delivery-time";
import { brand } from "@/lib/brand";

export const STANDINGS = ["healthy", "watch", "at_risk", "paused"] as const;
export type Standing = (typeof STANDINGS)[number];

export const STANDING_LABEL: Record<Standing, string> = {
  healthy: "Healthy",
  watch: "Watch",
  at_risk: "At risk",
  paused: "Paused",
};

/** Watch starts at this share of the stall line. */
export const WATCH_SHARE = 0.5;

/** At risk starts at this share of the stall line: 2% bounce, the usual industry ceiling. */
export const AT_RISK_SHARE = 0.8;

/** Behavior signals read the last day against the week before it. */
export const SIGNAL_WINDOW_HOURS = 24;
export const BASELINE_DAYS = 7;

/** A day's volume against the baseline's daily average. */
export const SPIKE_WATCH_MULTIPLE = 5;
export const SPIKE_AT_RISK_MULTIPLE = 20;
/** Below this many messages in a day, a spike is too small to matter. */
export const SPIKE_MIN_VOLUME = 200;
/** Below this many distinct recipients in a day, a spike is people already in touch, not a list. */
export const SPIKE_MIN_RECIPIENTS = 50;

/** Share of a day's recipients never sent to before. */
export const FIRST_TIME_WATCH_SHARE = 0.5;
export const FIRST_TIME_AT_RISK_SHARE = 0.8;
export const FIRST_TIME_MIN_RECIPIENTS = 100;

/** Sends refused in a day because a recipient is suppressed. */
export const SUPPRESSED_WATCH_COUNT = 10;
export const SUPPRESSED_AT_RISK_COUNT = 50;

/** A domain verified this recently is on its first sends. */
export const NEW_DOMAIN_DAYS = 14;

/** Share of the provider's own reported mail failing DMARC that's watch, from this many messages. */
export const DMARC_FAILING_WATCH_SHARE = 0.05;
export const DMARC_FAILING_MIN_MESSAGES = 100;
/** Days of DMARC reports the signal reads. */
export const DMARC_SIGNAL_DAYS = 7;

const RANK: Record<Standing, number> = { healthy: 0, watch: 1, at_risk: 2, paused: 3 };

export function worseStanding(a: Standing, than: Standing): boolean {
  return RANK[a] > RANK[than];
}

export function worstOf(standings: Standing[]): Standing {
  return standings.reduce<Standing>((worst, next) => (worseStanding(next, worst) ? next : worst), "healthy");
}

export type FindingKind =
  | "paused"
  | "stall_pending"
  | `${StallMetric}_rate`
  | `${StallMetric}_count`
  | "volume_spike"
  | "first_time_recipients"
  | "suppressed_sends"
  | "delivery_time"
  | "new_domain_bounces"
  | "provider_finding"
  | "provider_rate"
  | "blocklist_listing"
  | "linked_domain_listing"
  | "dmarc_failing";

/** Findings that lead to a pause, by the stall guard or the provider. */
const PAUSE_PATH = new Set<FindingKind>([
  "paused",
  "stall_pending",
  "bounce_rate",
  "complaint_rate",
  "bounce_count",
  "complaint_count",
  "provider_rate",
  "provider_finding",
]);
const LISTINGS = new Set<FindingKind>(["blocklist_listing", "linked_domain_listing"]);

/** What an at-risk alert is about: a coming pause, a blocklist that filters mail, or unusual sending worth a look. */
export type AlertTone = "pausing" | "listed" | "look";

export function alertTone(findings: Pick<Finding, "kind" | "standing">[]): AlertTone {
  const raised = findings.filter((finding) => finding.standing !== "watch");
  if (raised.length === 0 || raised.some((finding) => PAUSE_PATH.has(finding.kind))) return "pausing";
  if (raised.some((finding) => LISTINGS.has(finding.kind))) return "listed";
  return "look";
}

export interface Finding {
  kind: FindingKind;
  standing: Exclude<Standing, "healthy">;
  /** What's happening, naming the subject. */
  title: string;
  /** The numbers behind it. */
  body: string;
  /** What to do now. */
  action: string;
  /** A domain whose reputation page details this, when the subject is an organization. */
  domainId?: string;
  /** The outcome behind it, when messages with that outcome are the evidence. */
  metric?: StallMetric;
}

export interface BehaviorSignals {
  /** Accepted in the last `SIGNAL_WINDOW_HOURS`. */
  recentTotal: number;
  /** Accepted over the `BASELINE_DAYS` before that. */
  baselineTotal: number;
  /** Distinct recipients in the last `SIGNAL_WINDOW_HOURS`, and how many were first seen in it. */
  recentRecipients: number;
  firstTimeRecipients: number;
  suppressedRejections: number;
  /** Set when the latest p90 delivery time is well above the domain's own normal. */
  deliveryTime?: DeliveryShift | null;
  verifiedAt: Date | null;
  now: Date;
}

export interface Pause {
  reason: string;
  since: Date;
}

/** A blocklist naming the sending domain, or a domain its recent mail linked to. */
export interface BlocklistListing {
  domain: string;
  source: "sending" | "link";
  list: BlocklistId;
  code: string;
  reason: string;
  /** Link listings: messages in the last `SIGNAL_WINDOW_HOURS` that linked to it. */
  messages?: number;
}

export interface StandingInput {
  /** The domain or organization name the copy names. */
  subject: string;
  blocklists?: BlocklistListing[];
  /** `STALL_WINDOW_DAYS` of counts and the window before, as the stall guard reads them. */
  counts: OutcomeCounts;
  previousCounts: OutcomeCounts;
  signals: BehaviorSignals | null;
  pause: Pause | null;
  lines: StallLines;
  /** The provider's own mail in DMARC reports over `DMARC_SIGNAL_DAYS`, and how much failed. */
  dmarc?: { messages: number; failing: number } | null;
}

/** One metric in one window, with every line it's measured against. */
export interface MetricReading {
  metric: StallMetric;
  count: number;
  denominator: number;
  /** Null below `RATE_FLOOR`. */
  rate: number | null;
  previousRate: number | null;
  delta: number | null;
  watchLine: number;
  atRiskLine: number;
  stallLine: number;
  providerReviewLine: number;
  providerPauseLine: number;
}

export interface StandingResult {
  standing: Standing;
  findings: Finding[];
}

/** Digits that keep each metric's lines distinct: 1.25% and 0.025%. */
export const RATE_DIGITS: Record<StallMetric, number> = { bounce: 2, complaint: 3 };

const NOUN: Record<StallMetric, { one: string; many: string; title: string }> = {
  bounce: { one: "bounce", many: "bounces", title: "Bounce" },
  complaint: { one: "complaint", many: "complaints", title: "Complaint" },
};

const ACTION: Record<StallMetric, string> = {
  bounce: "Remove addresses that bounce and check how new addresses are collected.",
  complaint: "Send only to people who asked for this mail, and make unsubscribing easy.",
};

export function readMetric(metric: StallMetric, counts: OutcomeCounts, previousCounts: OutcomeCounts, stallLines: StallLines): MetricReading {
  const lines = stallLines[metric];
  const denominator = resolved(counts);
  const current = rate(counts[metric === "bounce" ? "bounced" : "complained"], denominator);
  const previous = rate(previousCounts[metric === "bounce" ? "bounced" : "complained"], resolved(previousCounts));
  return {
    metric,
    count: counts[metric === "bounce" ? "bounced" : "complained"],
    denominator,
    rate: current,
    previousRate: previous,
    delta: rateDelta(current, previous),
    watchLine: lines.stall * WATCH_SHARE,
    atRiskLine: lines.stall * AT_RISK_SHARE,
    stallLine: lines.stall,
    providerReviewLine: lines.providerReview,
    providerPauseLine: lines.providerPause,
  };
}

function plural(count: number, one: string, many: string): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

function rateFinding(subject: string, reading: MetricReading): Finding | null {
  const { metric } = reading;
  const atRisk = projectsPast(reading.rate, reading.previousRate, reading.atRiskLine);
  const crossing = atRisk ?? projectsPast(reading.rate, reading.previousRate, reading.watchLine);
  if (!crossing || reading.rate === null) return null;

  const digits = RATE_DIGITS[metric];
  const now = formatRate(reading.rate, digits);
  const before = formatRate(reading.previousRate, digits);
  const change =
    reading.previousRate === null
      ? ""
      : before === now
        ? `, the same as the ${STALL_WINDOW_DAYS} days before`
        : `, ${reading.delta !== null && reading.delta > 0 ? "up" : "down"} from ${before}`;
  return {
    kind: `${metric}_rate`,
    metric,
    standing: atRisk ? "at_risk" : "watch",
    title:
      crossing === "trend"
        ? `${NOUN[metric].title}s on ${subject} are rising: ${formatRate(reading.previousRate, digits)} to ${formatRate(reading.rate, digits)}`
        : `${NOUN[metric].title} rate on ${subject} is ${formatRate(reading.rate, digits)}`,
    body: `${formatRate(reading.rate, digits)} of ${formatNumber(reading.denominator)} resolved messages in ${STALL_WINDOW_DAYS} days${change}. Sending pauses at ${formatRate(reading.stallLine, digits)}; the provider reviews its own senders at ${formatRate(reading.providerReviewLine, digits)}.`,
    action: ACTION[metric],
  };
}

function countFinding(subject: string, reading: MetricReading, lines: StallLines): Finding | null {
  const { metric } = reading;
  const floor = lines[metric].count;
  if (reading.rate !== null || reading.count < floor) return null;
  return {
    kind: `${metric}_count`,
    metric,
    standing: "at_risk",
    title: `${plural(reading.count, NOUN[metric].one, NOUN[metric].many)} on ${subject}`,
    body: `${plural(reading.count, NOUN[metric].one, NOUN[metric].many)} on ${plural(reading.denominator, "resolved message", "resolved messages")} in ${STALL_WINDOW_DAYS} days. Too few for a rate; once ${lines.countVolumeFloor} messages have resolved, this many pauses sending.`,
    action: ACTION[metric],
  };
}

function signalFindings(subject: string, signals: BehaviorSignals, counts: OutcomeCounts, lines: StallLines): Finding[] {
  const findings: Finding[] = [];
  const hours = SIGNAL_WINDOW_HOURS;

  const daily = signals.baselineTotal / BASELINE_DAYS;
  if (signals.baselineTotal > 0 && signals.recentTotal >= SPIKE_MIN_VOLUME && signals.recentRecipients >= SPIKE_MIN_RECIPIENTS) {
    const multiple = signals.recentTotal / daily;
    if (multiple >= SPIKE_WATCH_MULTIPLE) {
      findings.push({
        kind: "volume_spike",
        standing: multiple >= SPIKE_AT_RISK_MULTIPLE ? "at_risk" : "watch",
        title: `Volume on ${subject} is up ${Math.floor(multiple)}×`,
        body: `${plural(signals.recentTotal, "message", "messages")} to ${plural(signals.recentRecipients, "recipient", "recipients")} in ${hours} hours, against a daily average of ${formatNumber(Math.round(daily))} messages over the previous ${BASELINE_DAYS} days.`,
        action: "If you expected it, you're all set. If not, take a look at what sent it.",
      });
    }
  }

  if (signals.baselineTotal > 0 && signals.recentRecipients >= FIRST_TIME_MIN_RECIPIENTS) {
    const share = signals.firstTimeRecipients / signals.recentRecipients;
    if (share >= FIRST_TIME_WATCH_SHARE) {
      findings.push({
        kind: "first_time_recipients",
        standing: share >= FIRST_TIME_AT_RISK_SHARE ? "at_risk" : "watch",
        title: `Most recipients on ${subject} are new`,
        body: `${Math.round(share * 100)}% of ${plural(signals.recentRecipients, "recipient", "recipients")} in ${hours} hours had never been sent to before. A list nobody has mailed carries unknown bounces and complaints.`,
        action: "Confirm addresses before sending, or send to a small part of the list first.",
      });
    }
  }

  if (signals.suppressedRejections >= SUPPRESSED_WATCH_COUNT) {
    findings.push({
      kind: "suppressed_sends",
      standing: signals.suppressedRejections >= SUPPRESSED_AT_RISK_COUNT ? "at_risk" : "watch",
      title: `${subject} keeps sending to suppressed addresses`,
      body: `${plural(signals.suppressedRejections, "send was", "sends were")} refused in ${hours} hours because a recipient is suppressed.`,
      action: "Remove suppressed addresses from the list that sends here. The API refuses them every time.",
    });
  }

  if (signals.deliveryTime) {
    findings.push({
      kind: "delivery_time",
      standing: "watch",
      title: `Delivery on ${subject} is ${shiftMultiple(signals.deliveryTime)}× slower than usual`,
      body: `The slowest tenth of messages took ${describeDeliveryShift(signals.deliveryTime)}. Slow delivery often comes before bounces: a mailbox provider is throttling the domain.`,
      action: "Spread sends out and check recent bounce reasons.",
    });
  }

  const denominator = resolved(counts);
  const fresh =
    signals.verifiedAt !== null && signals.now.getTime() - signals.verifiedAt.getTime() < NEW_DOMAIN_DAYS * 24 * 60 * 60 * 1000;
  if (fresh && denominator < RATE_FLOOR && counts.bounced > 0 && counts.bounced < lines.bounce.count) {
    findings.push({
      kind: "new_domain_bounces",
      standing: "watch",
      title: `${subject} bounced on its first sends`,
      body: `${plural(counts.bounced, "bounce", "bounces")} on its first ${plural(denominator, "resolved message", "resolved messages")}. A new domain has no reputation to absorb them.`,
      action: "Check the addresses before sending more.",
    });
  }

  return findings;
}

/** The provider's own mail failing DMARC at the receiver. Watch only: under p=none it's still delivered. */
export function dmarcFindings(subject: string, dmarc: { messages: number; failing: number } | null | undefined): Finding[] {
  if (!dmarc || dmarc.messages < DMARC_FAILING_MIN_MESSAGES) return [];
  const share = dmarc.failing / dmarc.messages;
  if (share < DMARC_FAILING_WATCH_SHARE) return [];
  return [
    {
      kind: "dmarc_failing",
      standing: "watch",
      title: `${Math.round(share * 100)}% of ${subject}'s mail failed DMARC`,
      body: `Mailbox providers reported ${plural(dmarc.failing, "message", "messages")} of ${formatNumber(dmarc.messages)} sent through this domain's provider failing DMARC over ${DMARC_SIGNAL_DAYS} days. Under a stricter policy they'd be junked or refused.`,
      action: "Check that the DKIM records are still published, and that the DMARC record's alignment modes allow this domain's setup.",
    },
  ];
}

/** DBL listings are at risk. ZRD only says a domain is new to Spamhaus, so it's watch. */
function listingStanding(listings: BlocklistListing[]): "at_risk" | "watch" {
  return listings.some((listing) => listing.list === "dbl") ? "at_risk" : "watch";
}

function listNames(listings: BlocklistListing[]): string {
  return [...new Set(listings.map((listing) => BLOCKLIST_INFO[listing.list].label))].join(" and ");
}

function removalAction(listings: BlocklistListing[], lead: string): string {
  if (listings.some((listing) => listing.list === "dbl")) {
    return `${lead} then request removal at ${BLOCKLIST_INFO.dbl.removalUrl}. Removal is free.`;
  }
  return "ZRD listings end on their own 24 hours after Spamhaus first sees a domain. Keep volume low until then.";
}

export function blocklistFindings(subject: string, listings: BlocklistListing[]): Finding[] {
  const findings: Finding[] = [];
  const own = listings.filter((listing) => listing.source === "sending");
  if (own.length > 0) {
    const detail = own.map((listing) => `${BLOCKLIST_INFO[listing.list].label}: ${listing.reason} (${listing.code})`).join("; ");
    findings.push({
      kind: "blocklist_listing",
      standing: listingStanding(own),
      title: `${subject} is on ${listNames(own)}`,
      body: `${detail}. Mailbox providers that use the list junk or refuse mail from the domain.`,
      action: removalAction(own, "Find what got the domain listed, such as a compromised form or a bought list, and fix it,"),
    });
  }

  const linked = listings.filter((listing) => listing.source === "link");
  if (linked.length > 0) {
    const domains = [...new Set(linked.map((listing) => listing.domain))].sort();
    const shown = domains.slice(0, 3);
    const more = domains.length - shown.length;
    const messages = Math.max(...linked.map((listing) => listing.messages ?? 0));
    const detail = shown
      .map((domain) => {
        const on = linked.filter((listing) => listing.domain === domain);
        return `${domain} (${on.map((listing) => `${BLOCKLIST_INFO[listing.list].label}: ${listing.reason}`).join("; ")})`;
      })
      .join(", ");
    findings.push({
      kind: "linked_domain_listing",
      standing: listingStanding(linked),
      title:
        domains.length === 1
          ? `Mail from ${subject} links to a listed domain: ${domains[0]}`
          : `Mail from ${subject} links to ${domains.length} listed domains`,
      body: `${messages > 0 ? `${plural(messages, "message", "messages")} in ${SIGNAL_WINDOW_HOURS} hours linked to ` : "Recent mail linked to "}${detail}${more > 0 ? ` and ${more} more` : ""}. Mailbox providers junk mail that links to listed domains.`,
      action: removalAction(linked, `Remove the ${domains.length === 1 ? "link" : "links"}. If ${domains.length === 1 ? "the domain is" : "a domain is"} yours, fix the cause and`),
    });
  }
  return findings;
}

function standingOf(findings: Finding[]): Standing {
  return worstOf(findings.map((finding) => finding.standing));
}

/** Worst first, so a banner list leads with what matters. */
function ordered(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => RANK[b.standing] - RANK[a.standing]);
}

function rateAndCountFindings(subject: string, counts: OutcomeCounts, previousCounts: OutcomeCounts, lines: StallLines): Finding[] {
  const verdict = evaluateStall({ counts, previousCounts, lines });
  const findings: Finding[] = [];
  if (verdict) {
    findings.push({
      kind: "stall_pending",
      metric: verdict.detail.metric,
      standing: "at_risk",
      title: `${subject} pauses at the reputation guard's next check`,
      body: describeStall(verdict.reason, verdict.detail),
      action: `${ACTION[verdict.detail.metric]} Queued mail is held, not lost.`,
    });
  }
  for (const metric of ["complaint", "bounce"] as const) {
    if (verdict?.detail.metric === metric) continue;
    const reading = readMetric(metric, counts, previousCounts, lines);
    const finding = rateFinding(subject, reading) ?? countFinding(subject, reading, lines);
    if (finding) findings.push(finding);
  }
  return findings;
}

/** One metric's standing from counts alone: the stall guard, then the at-risk and watch lines, then the count line. */
export function metricStanding(metric: StallMetric, counts: OutcomeCounts, previousCounts: OutcomeCounts, lines: StallLines): Standing {
  return standingOf(rateAndCountFindings("", counts, previousCounts, lines).filter((finding) => finding.metric === metric));
}

export function evaluateStanding(input: StandingInput): StandingResult {
  if (input.pause) {
    return {
      standing: "paused",
      findings: [
        {
          kind: "paused",
          standing: "paused",
          title: `${input.subject} is paused`,
          body: input.pause.reason,
          action: "Fix the cause, then release the hold on the domain page. Queued mail goes out once it's released.",
        },
      ],
    };
  }

  const findings = [
    ...rateAndCountFindings(input.subject, input.counts, input.previousCounts, input.lines),
    ...(input.signals ? signalFindings(input.subject, input.signals, input.counts, input.lines) : []),
    ...blocklistFindings(input.subject, input.blocklists ?? []),
    ...dmarcFindings(input.subject, input.dmarc),
  ];
  return { standing: standingOf(findings), findings: ordered(findings) };
}

export interface OrganizationStandingInput {
  subject: string;
  /** Summed counts, minus domains the domain guard covers (`organizationSums`). */
  sums: { counts: OutcomeCounts; previousCounts: OutcomeCounts };
  /** The org guard only reads sums across two or more sending domains. */
  sendingDomains: number;
  suspension: Pause | null;
  domains: { id: string; name: string; standing: Standing }[];
  /** Open reputation findings the provider reported, which never pause on their own. */
  providerFindings?: ProviderFinding[];
  /** The provider's own rates for providers the organization's domains send through. */
  providerRates?: ProviderRates[];
  lines: StallLines;
}

export interface ProviderFinding {
  type: string;
  impact: string | null;
  description: string | null;
  domainId?: string;
}

export interface ProviderRates {
  providerName: string;
  bounceRate: number | null;
  complaintRate: number | null;
  /** Metrics a domain on the provider, or the organization's own sums, already has a finding for. */
  covered: StallMetric[];
  domainId?: string;
}

/**
 * AWS's rate for a provider against Pouch's watch and at-risk lines. Never paused: the stall
 * guard and suspension stay the only actors.
 */
export function providerRateFindings(subject: string, provider: ProviderRates, stallLines: StallLines): Finding[] {
  const findings: Finding[] = [];
  for (const metric of ["complaint", "bounce"] as const) {
    const value = metric === "bounce" ? provider.bounceRate : provider.complaintRate;
    if (value === null || provider.covered.includes(metric)) continue;
    const lines = stallLines[metric];
    const atRiskLine = lines.stall * AT_RISK_SHARE;
    const watchLine = lines.stall * WATCH_SHARE;
    if (value < watchLine) continue;
    const digits = RATE_DIGITS[metric];
    findings.push({
      kind: "provider_rate",
      metric,
      standing: value >= atRiskLine ? "at_risk" : "watch",
      title: `AWS reports a ${formatRate(value, digits)} ${metric} rate on ${provider.providerName}`,
      body: `That's the rate AWS enforces for the whole provider, including mail ${subject}'s domains didn't send through ${brand.name}. AWS reviews the provider at ${formatRate(lines.providerReview, digits)} and pauses it at ${formatRate(lines.providerPause, digits)}.`,
      action: ACTION[metric],
      ...(provider.domainId ? { domainId: provider.domainId } : {}),
    });
  }
  return findings;
}

function providerFinding(subject: string, finding: ProviderFinding): Finding {
  const type = finding.type.toLowerCase();
  return {
    kind: "provider_finding",
    ...(type === "bounce" || type === "complaint" ? { metric: type } : {}),
    standing: finding.impact === "HIGH" ? "at_risk" : "watch",
    title: `AWS flagged ${type === "bounce" || type === "complaint" ? `${type}s` : type} on ${subject}`,
    body: finding.description ?? "SES opened a reputation finding for this organization.",
    action:
      type === "bounce"
        ? ACTION.bounce
        : type === "complaint"
          ? ACTION.complaint
          : "Fix the cause before SES pauses sending. The finding closes once it's resolved.",
    ...(finding.domainId ? { domainId: finding.domainId } : {}),
  };
}

/** Metrics a set of findings already speaks to. A pause or pending stall speaks to both. */
export function coveredMetrics(findings: Pick<Finding, "kind">[]): StallMetric[] {
  const covered = new Set<StallMetric>();
  for (const { kind } of findings) {
    if (kind === "paused" || kind === "stall_pending") {
      covered.add("bounce");
      covered.add("complaint");
    }
    if (kind === "bounce_rate" || kind === "bounce_count") covered.add("bounce");
    if (kind === "complaint_rate" || kind === "complaint_count") covered.add("complaint");
  }
  return [...covered];
}

export interface OrganizationStandingResult extends StandingResult {
  /** From the organization's own findings only, not its domains'. Alerts use this. */
  ownStanding: Standing;
  /** Domains that aren't healthy, worst first. */
  attention: { id: string; name: string; standing: Standing }[];
}

/** The organization's own findings, and the worst of its domains with a paused domain counting as at risk. */
export function evaluateOrganizationStanding(input: OrganizationStandingInput): OrganizationStandingResult {
  const attention = input.domains
    .filter((domain) => domain.standing !== "healthy")
    .sort((a, b) => RANK[b.standing] - RANK[a.standing] || a.name.localeCompare(b.name));

  if (input.suspension) {
    return {
      standing: "paused",
      findings: [
        {
          kind: "paused",
          standing: "paused",
          title: `${input.subject} is suspended`,
          body: input.suspension.reason,
          action: "Contact an admin to lift it.",
        },
      ],
      ownStanding: "paused",
      attention,
    };
  }

  const sumFindings = input.sendingDomains >= 2 ? rateAndCountFindings(input.subject, input.sums.counts, input.sums.previousCounts, input.lines) : [];
  const sumCovered = coveredMetrics(sumFindings);
  const findings = [
    ...(input.providerFindings ?? []).map((finding) => providerFinding(input.subject, finding)),
    ...sumFindings,
    ...(input.providerRates ?? []).flatMap((provider) =>
      providerRateFindings(input.subject, { ...provider, covered: [...provider.covered, ...sumCovered] }, input.lines),
    ),
  ];
  const fromDomains = input.domains.map((domain) => (domain.standing === "paused" ? "at_risk" : domain.standing));
  return {
    standing: worstOf([standingOf(findings), ...fromDomains]),
    ownStanding: standingOf(findings),
    findings: ordered(findings),
    attention,
  };
}

/** One sentence on why a subject isn't healthy. Null when it is. */
export function standingReason(result: {
  standing: Standing;
  findings: Finding[];
  attention?: { name: string; standing: Standing }[];
}): string | null {
  if (result.standing === "healthy") return null;
  const lead = result.findings[0];
  if (lead) return `${lead.title}.`;
  const names = (result.attention ?? []).map((domain) => domain.name);
  if (names.length === 0) return "Needs a look.";
  const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${listed} ${names.length === 1 ? "needs" : "need"} a look.`;
}
