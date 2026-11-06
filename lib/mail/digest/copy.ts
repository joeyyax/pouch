/** The subject and body for one digest email. */
import { baseUrl } from "@/lib/api/urls";
import type { StallLines, StallMetric } from "@/lib/domains/guard";
import { formatNumber } from "@/lib/format/number";
import { systemMailText, type MailBlock, type MailStat, type MailTone, type SystemMailBody } from "@/lib/mail/template";
import { describeDeliveryShift } from "@/lib/metrics/delivery-time";
import { EMPTY_COUNTS, formatRate, outcomeCounts, rate, resolved } from "@/lib/metrics/rates";
import { metricStanding, STANDING_LABEL, type Standing } from "@/lib/reputation/standing";
import type { DigestBreakdownRow, DigestObservation, DigestOrganizationCount, DigestOutcomes, DigestSummary } from "./metrics";
import type { DigestCadence, DigestWindow } from "./cadence";

const CADENCE_LABEL: Record<DigestCadence, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

type Metric = "bounced" | "complained";

const DIGITS: Record<Metric, number> = { bounced: 1, complained: 2 };

const STALL_METRIC: Record<Metric, StallMetric> = { bounced: "bounce", complained: "complaint" };

/** Watch reads as warn; at risk and paused read as bad. */
const STANDING_TONE: Record<Standing, MailTone> = { healthy: "good", watch: "warn", at_risk: "bad", paused: "bad" };

/** The metric's standing on these counts, as reputation computes it. */
function standingFor(outcomes: DigestOutcomes, metric: Metric, lines: StallLines, previous?: DigestOutcomes): Standing {
  return metricStanding(STALL_METRIC[metric], outcomeCounts(outcomes), previous ? outcomeCounts(previous) : EMPTY_COUNTS, lines);
}

function admin(path: string): string {
  return `${baseUrl()}/admin/settings/${path}`;
}

/** Opens the organization from the admin screen: switched into when you're a member, emulated after a confirm otherwise. */
function inOrganization(organizationId: string, path: string): string {
  return `${admin("organizations")}?org=${encodeURIComponent(organizationId)}&next=${encodeURIComponent(path)}`;
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** A UTC calendar date in words, such as "Wednesday, October 1". */
function utcDate(date: Date, options: Intl.DateTimeFormatOptions): string {
  const key = JSON.stringify(options);
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options });
    formats.set(key, format);
  }
  return format.format(date);
}

/** "Wednesday, October 1", "September 22 to 28", "September 29 to October 5", "September 2026". */
function windowLabel(window: DigestWindow): string {
  const { since } = window;
  if (window.cadence === "daily") return utcDate(since, { weekday: "long", month: "long", day: "numeric" });
  if (window.cadence === "monthly") return utcDate(since, { month: "long", year: "numeric" });
  const last = new Date(window.until.getTime() - 1);
  const end = since.getUTCMonth() === last.getUTCMonth() ? utcDate(last, { day: "numeric" }) : utcDate(last, { month: "long", day: "numeric" });
  return `${utcDate(since, { month: "long", day: "numeric" })} to ${end}`;
}

/** What the digest is named for: "Wednesday, October 1", "Week of September 21", "September 2026". */
function windowTitle(window: DigestWindow): string {
  if (window.cadence === "weekly") return `Week of ${utcDate(window.since, { month: "long", day: "numeric" })}`;
  return windowLabel(window);
}

/** "Midnight", "9 AM", "Noon", "11 PM". */
function hourLabel(start: Date): string {
  const hour = start.getUTCHours();
  if (hour === 0) return "Midnight";
  if (hour === 12) return "Noon";
  return `${hour % 12} ${hour < 12 ? "AM" : "PM"}`;
}

function rateOf(outcomes: DigestOutcomes, metric: Metric): number | null {
  return rate(outcomes[metric], resolved(outcomeCounts(outcomes)));
}

/** Below the floor there's no percentage to show, so the count stands in. */
function shownRate(outcomes: DigestOutcomes, metric: Metric): string {
  const fraction = rateOf(outcomes, metric);
  return fraction === null ? formatNumber(outcomes[metric]) : formatRate(fraction, DIGITS[metric]);
}

function toneOf(outcomes: DigestOutcomes, metric: Metric, lines: StallLines, previous?: DigestOutcomes): MailTone {
  const standing = standingFor(outcomes, metric, lines, previous);
  return standing === "healthy" && rateOf(outcomes, metric) === null ? "neutral" : STANDING_TONE[standing];
}

type Change = NonNullable<MailStat["change"]>;

function pointsChange(now: number | null, before: number | null, digits: number, upTone: MailTone, downTone: MailTone): Change | undefined {
  if (now === null || before === null) return undefined;
  const points = (now - before) * 100;
  if (Math.abs(points) < 10 ** -digits / 2) return { direction: "flat", text: "Same as before", tone: "neutral" };
  const up = points > 0;
  return { direction: up ? "up" : "down", text: `${Math.abs(points).toFixed(digits)} pts`, tone: up ? upTone : downTone };
}

function rateChange(summary: DigestSummary, metric: Metric): Change | undefined {
  const tone = toneOf(summary, metric, summary.lines, summary.previous);
  return pointsChange(rateOf(summary, metric), rateOf(summary.previous, metric), DIGITS[metric], tone === "bad" || tone === "warn" ? tone : "neutral", "good");
}

/** Why a rate tile has no change line. */
function rateNote(summary: DigestSummary, metric: Metric): string | undefined {
  if (rateOf(summary, metric) === null) return "Too few to rate";
  if (rateOf(summary.previous, metric) === null) return "No rate the window before";
  return undefined;
}

function volumeChange(total: number, previousTotal: number): Change | undefined {
  if (previousTotal === 0) return undefined;
  const delta = Math.round(((total - previousTotal) / previousTotal) * 100);
  if (delta === 0) return { direction: "flat", text: `Same as ${formatNumber(previousTotal)}`, tone: "neutral" };
  return { direction: delta > 0 ? "up" : "down", text: `${Math.abs(delta)}% from ${formatNumber(previousTotal)}`, tone: delta > 0 ? "good" : "neutral" };
}

function statsBlock(summary: DigestSummary): MailBlock {
  const deliveredRate = rate(summary.delivered, resolved(outcomeCounts(summary)));
  const previousDelivered = rate(summary.previous.delivered, resolved(outcomeCounts(summary.previous)));
  return {
    kind: "stats",
    stats: [
      {
        label: "Sent",
        value: formatNumber(summary.total),
        href: admin("system"),
        change: volumeChange(summary.total, summary.previousTotal),
        detail: summary.previousTotal === 0 ? "Nothing sent the window before" : undefined,
      },
      {
        label: "Delivered",
        value: deliveredRate === null ? formatNumber(summary.delivered) : formatRate(deliveredRate, 1),
        href: admin("system"),
        change: pointsChange(deliveredRate, previousDelivered, 1, "good", summary.failed > 0 ? "warn" : "neutral"),
        detail: summary.failed > 0 ? `${formatNumber(summary.failed)} failed outright` : undefined,
        tone: summary.failed > 0 ? "warn" : "neutral",
      },
      {
        label: "Bounced",
        value: shownRate(summary, "bounced"),
        href: admin("system"),
        change: rateChange(summary, "bounced"),
        detail: rateNote(summary, "bounced"),
        tone: toneOf(summary, "bounced", summary.lines, summary.previous),
      },
      {
        label: "Complained",
        value: shownRate(summary, "complained"),
        href: admin("system"),
        change: rateChange(summary, "complained"),
        detail: rateNote(summary, "complained"),
        tone: toneOf(summary, "complained", summary.lines, summary.previous),
      },
    ],
  };
}

function barsBlock(summary: DigestSummary): MailBlock | null {
  if (summary.buckets.length === 0) return null;
  const hourly = summary.window.cadence === "daily";
  const label = (start: Date) => (hourly ? hourLabel(start) : utcDate(start, summary.window.cadence === "weekly" ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" }));
  return {
    kind: "bars",
    title: hourly ? "Sent by hour" : "Sent by day",
    bars: summary.buckets.map((bucket) => ({ label: label(bucket.start), value: bucket.total })),
    caption: hourly ? "Hours in UTC." : "Days in UTC.",
    href: admin("system"),
  };
}

function plural(count: number, one: string, many: string): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

function perOrganization(rows: DigestOrganizationCount[], one: string, many: string, tone: MailTone, path: string) {
  return rows.map((row) => ({ text: `${row.organization}: ${plural(row.count, one, many)}`, tone, href: inOrganization(row.organizationId, path) }));
}

type AttentionItem = { text: string; tone: MailTone; href?: string };

const OBSERVATION_TONE = { danger: "bad", warning: "warn", info: "neutral" } as const;

function observationItems(rows: DigestObservation[]): AttentionItem[] {
  return rows.map((row) => ({ text: `${row.organization}: ${row.text}`, tone: OBSERVATION_TONE[row.tone], href: inOrganization(row.organizationId, row.path) }));
}

/** Info-tone observations: what changed, not what needs a look. */
function changesBlock(summary: DigestSummary): MailBlock | null {
  const items = observationItems(summary.attention.observations.filter((row) => row.tone === "info"));
  return items.length > 0 ? { kind: "list", title: "Changes in volume", items } : null;
}

const METRIC_NAME: Record<Metric, string> = { bounced: "Bounce rate", complained: "Complaint rate" };

const COUNT_NAME: Record<Metric, [string, string]> = { bounced: ["bounce", "bounces"], complained: ["complaint", "complaints"] };

type Crossing = { metric: Metric; standing: "watch" | "at_risk"; shown: string; counted: boolean };

const standingWords = (standing: Crossing["standing"]) => (standing === "at_risk" ? "at risk" : "on watch");

/** "Postmark: bounce rate 8.2% and complaint rate 0.88%, at risk": one subject, what it measured and where that puts it. */
function crossingText(prefix: string, crossings: Crossing[]): string {
  const name = (crossing: Crossing, index: number) => {
    if (crossing.counted) return crossing.shown;
    const label = METRIC_NAME[crossing.metric];
    return `${prefix || index > 0 ? label.toLowerCase() : label} ${crossing.shown}`;
  };
  const lead = prefix;
  const [first, second] = crossings as [Crossing, Crossing?];
  if (!second || first.standing === second.standing) {
    return `${lead}${crossings.map(name).join(" and ")}, ${standingWords(first.standing)}`;
  }
  return crossings.map((crossing, index) => `${index === 0 ? lead : ""}${name(crossing, index)} ${standingWords(crossing.standing)}`).join(", ");
}

/** Every warn or bad mark the tiles and tables carry, one item per subject. */
function thresholdItems(summary: DigestSummary): AttentionItem[] {
  const metrics: Metric[] = ["bounced", "complained"];
  const subjects: { outcomes: DigestOutcomes; previous?: DigestOutcomes; prefix: string; href: string }[] = [
    { outcomes: summary, previous: summary.previous, prefix: "", href: admin("system") },
    ...summary.providers.map((row) => ({ outcomes: row, prefix: `${row.name}: `, href: admin(`providers/${row.id}`) })),
    ...summary.organizations.map((row) => ({ outcomes: row, prefix: `${row.name}: `, href: inOrganization(row.id, "/messages") })),
  ];
  // The same messages behind a tile and a row are one cause: the first subject to show them keeps them.
  const seen = new Set<string>();
  const items = subjects.flatMap(({ outcomes, previous, prefix, href }): AttentionItem[] => {
    const crossings = metrics.flatMap((metric): Crossing[] => {
      const standing = standingFor(outcomes, metric, summary.lines, previous);
      const key = `${metric}:${outcomes[metric]}:${resolved(outcomeCounts(outcomes))}`;
      if (standing === "healthy" || seen.has(key)) return [];
      seen.add(key);
      const counted = rateOf(outcomes, metric) === null;
      return [
        {
          metric,
          standing: standing === "watch" ? "watch" : "at_risk",
          shown: counted ? plural(outcomes[metric], ...COUNT_NAME[metric]) : shownRate(outcomes, metric),
          counted,
        },
      ];
    });
    if (crossings.length === 0) return [];
    return [{ text: crossingText(prefix, crossings), tone: crossings.some((crossing) => crossing.standing === "at_risk") ? "bad" : "warn", href }];
  });
  if (summary.failed > 0) items.push({ text: `${plural(summary.failed, "message", "messages")} failed outright`, tone: "warn", href: admin("system") });
  return items;
}

function attentionItems(summary: DigestSummary): AttentionItem[] {
  const { attention, window } = summary;
  return [
    ...attention.standingChanges.map((change) => ({
      text: `${change.subject} moved to ${STANDING_LABEL[change.standing].toLowerCase()}${change.domainId ? ` (${change.organization})` : ""}`,
      tone: change.standing === "watch" ? ("warn" as const) : ("bad" as const),
      href: inOrganization(change.organizationId, change.domainId ? `/domains/${change.domainId}/reputation` : "/"),
    })),
    ...attention.findings.map((finding) => ({
      text: `${finding.provider} opened a ${finding.type} finding on ${finding.organization}`,
      tone: "bad" as const,
      href: admin(`providers/${finding.providerId}`),
    })),
    ...attention.stalledDomains.map((domain) => ({
      text: `${domain.domain} paused (${domain.organization})`,
      tone: "bad" as const,
      href: inOrganization(domain.organizationId, `/domains/${domain.domainId}/reputation`),
    })),
    ...attention.slowDomains.map((domain) => ({
      text: `${domain.domain} (${domain.organization}): the slowest tenth of messages took ${describeDeliveryShift(domain)}. Slow delivery often comes before bounces.`,
      tone: "warn" as const,
      href: inOrganization(domain.organizationId, `/domains/${domain.domainId}/reputation`),
    })),
    ...observationItems(attention.observations.filter((row) => row.tone !== "info")),
    ...attention.suspended.map((org) => ({
      text: `${org.organization} was suspended`,
      tone: "bad" as const,
      href: `${admin("organizations")}?org=${encodeURIComponent(org.organizationId)}`,
    })),
    ...perOrganization(attention.webhooksExhausted, "webhook delivery gave up", "webhook deliveries gave up", "warn", "/keys"),
    ...perOrganization(attention.endpointsDisabled, "webhook endpoint was disabled", "webhook endpoints were disabled", "warn", "/keys"),
    ...perOrganization(
      attention.failedSignIns,
      "failed sign-in",
      "failed sign-ins",
      "warn",
      `/activity?family=session&outcome=failure&since=${encodeURIComponent(window.since.toISOString())}`,
    ),
    ...thresholdItems(summary),
  ];
}

/** The list when something needs a look, the all-clear callout when nothing does. */
function attentionBlock(items: AttentionItem[]): MailBlock {
  if (items.length === 0) return { kind: "callout", tone: "good", text: "All clear. Nothing needs a look this window." };
  return { kind: "list", title: "Needs a look", items };
}

function breakdownBlock(
  title: string,
  column: string,
  rows: DigestBreakdownRow[],
  href: (row: DigestBreakdownRow) => string,
  lines: StallLines,
): MailBlock {
  return {
    kind: "table",
    title,
    columns: [column, "Sent", "Bounced", "Complained"],
    rows: rows.map((row) => ({
      cells: [row.name, formatNumber(row.total), shownRate(row, "bounced"), shownRate(row, "complained")],
      tones: [undefined, undefined, toneOf(row, "bounced", lines), toneOf(row, "complained", lines)],
      href: href(row),
    })),
  };
}

function alsoBlock(summary: DigestSummary): MailBlock | null {
  const { inbound, growth } = summary;
  const rows: [string, number, string?][] = [
    ["Inbound received", inbound.received],
    ["Flagged as spam", inbound.spam],
    ["Failed DMARC", inbound.dmarcFailed],
    ["Failed the virus scan", inbound.virus],
    ["New organizations", growth.organizations, admin("organizations")],
    ["Domains verified", growth.domainsVerified],
    ["Keys created", growth.keys],
    ["Suppressions added", growth.suppressions],
  ];
  const shown = rows.filter(([, count]) => count > 0);
  if (shown.length === 0) return null;
  return { kind: "table", title: "Also this window", columns: ["", ""], rows: shown.map(([label, count, href]) => ({ cells: [label, formatNumber(count)], href })) };
}

export function digestSubject(summary: DigestSummary): string {
  return `${windowTitle(summary.window)} digest: ${formatNumber(summary.total)} sent`;
}

export function digestMail(summary: DigestSummary, unsubscribeUrl: string): SystemMailBody {
  const label = CADENCE_LABEL[summary.window.cadence];
  const items = attentionItems(summary);
  const attention = attentionBlock(items);
  const stats = statsBlock(summary);
  const blocks = [
    attention,
    stats,
    ...[barsBlock(summary), changesBlock(summary)].filter((block): block is MailBlock => block !== null),
    ...(summary.providers.length > 0
      ? [breakdownBlock("By provider", "Provider", summary.providers, (row) => admin(`providers/${row.id}`), summary.lines)]
      : []),
    ...(summary.organizations.length > 0
      ? [breakdownBlock("Top organizations", "Organization", summary.organizations, (row) => inOrganization(row.id, "/messages"), summary.lines)]
      : []),
    ...[alsoBlock(summary)].filter((block): block is MailBlock => block !== null),
  ];

  return {
    heading: `${windowTitle(summary.window)} digest`,
    preheader: `${windowLabel(summary.window)}: ${items.length === 0 ? "all clear" : `${plural(items.length, "thing needs", "things need")} a look`}. ${formatNumber(summary.total)} sent across every organization, ${shownRate(summary, "bounced")} bounced, ${shownRate(summary, "complained")} complained.`,
    paragraphs: [],
    blocks,
    sections:
      summary.topBounceReasons.length > 0
        ? [{ title: "Top bounce and complaint reasons", lines: summary.topBounceReasons.map(({ reason, count }) => `${reason} (${count})`) }]
        : [],
    action: { label: "Open system status", url: admin("system") },
    reason: `You get the ${label.toLowerCase()} digest as an admin on ${new URL(baseUrl()).host}.`,
    footerLink: { label: `Turn off the ${label.toLowerCase()} digest`, url: unsubscribeUrl },
  };
}

export function digestText(summary: DigestSummary, unsubscribeUrl: string): string {
  return systemMailText(digestMail(summary, unsubscribeUrl));
}
