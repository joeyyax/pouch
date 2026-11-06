import type { DomainDailyStatsRow, MessageEventKind, MessageStatus } from "@/lib/db/schema";
import type { MessageFact, MessageFactTone } from "@/lib/dashboard/views/messages";
import { spellDuration } from "@/lib/metrics/duration";
import { formatNumber as count, formatOrdinal } from "@/lib/format/number";

/** A fact at or above this score is shown on its own merit. Below it, it only keeps a lone fact company. */
export const NOTABLE_SCORE = 50;
export const MAX_FACTS = 4;

/** Thresholds, in the order the facts below use them. */
export const QUEUE_WAIT_NOTABLE_MS = 60_000;
export const QUEUE_WAIT_LONG_MS = 5 * 60_000;
export const FAST_DELIVERY_MS = 2_000;
export const SLOW_DELIVERY_MS = 10 * 60_000;
export const FIRST_SEEN_WITHIN_MS = 60_000;
export const ADDRESS_COUNT_FLOOR = 100;
export const FANOUT_FLOOR = 10;
export const FANOUT_LARGE = 100;
/** Delivered messages in the window before a percentile means anything. */
export const STATS_DELIVERED_FLOOR = 50;
/** Sends in the 28-day window before an hour of day can be busy or quiet. */
export const STATS_VOLUME_FLOOR = 240;
/** Sensitive messages to one address in 7 days before it's worth saying. */
export const SENSITIVE_WEEK_FLOOR = 3;
/** Sensitive messages to one address in 24 hours that read as a possible attack. */
export const SENSITIVE_DAY_ALERT = 10;

type DomainStats = Pick<
  DomainDailyStatsRow,
  | "computedAt"
  | "deliveryWindowStart"
  | "deliveredCount"
  | "deliveryMinMs"
  | "deliveryP10Ms"
  | "deliveryP25Ms"
  | "deliveryP50Ms"
  | "deliveryP75Ms"
  | "deliveryP90Ms"
  | "deliveryP99Ms"
  | "deliveryMaxMs"
  | "volumeWindowStart"
  | "hourlyVolume"
>;

export interface FactInput {
  now: Date;
  domainName: string;
  testMode: boolean;
  createdAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  attempts: number;
  events: { kind: MessageEventKind; status: MessageStatus | null; detail: Record<string, unknown> }[];
  /** Messages to the only recipient. Null with more than one. */
  messageCount: number | null;
  /** The only recipient's history row. Null with more than one, or none on file. */
  history: { firstSeenAt: Date; bounceCount: number; complaintCount: number } | null;
  /** Recipients of the same body from the same key on the message's UTC day. */
  fanout: { recipients: number; day: string } | null;
  /** The domain's latest daily stats row. */
  stats: DomainStats | null;
  /**
   * A sensitive message to one recipient: its withheld reason, and how many like it went to that
   * address in the 7 days and the 24 hours up to it, itself included. Null otherwise.
   */
  sensitive: { reason: string; week: number; day: number } | null;
}

/** A fact and what it's about. Only the best fact per topic survives. */
interface Candidate extends MessageFact {
  topic: string;
}

function fact(topic: string, tone: MessageFactTone, score: number, text: string): Candidate {
  return { topic, tone, score: Math.round(score), text };
}

/** `1.8 seconds` under ten seconds, then whole units. */
export function span(ms: number): string {
  if (ms < 10_000) {
    const seconds = Number((ms / 1000).toFixed(1));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return spellDuration(ms);
}

function times(n: number): string {
  return n === 1 ? "one other time" : `${count(n)} other times`;
}

/** Where `value` falls among the stored quantiles, 0 to 100, interpolated linearly between them. */
export function percentileOf(value: number, stats: DomainStats): number | null {
  const points: [number, number | null][] = [
    [0, stats.deliveryMinMs],
    [10, stats.deliveryP10Ms],
    [25, stats.deliveryP25Ms],
    [50, stats.deliveryP50Ms],
    [75, stats.deliveryP75Ms],
    [90, stats.deliveryP90Ms],
    [99, stats.deliveryP99Ms],
    [100, stats.deliveryMaxMs],
  ];
  if (points.some(([, ms]) => ms === null)) return null;
  const curve = points as [number, number][];
  const [, min] = curve[0] as [number, number];
  const [, max] = curve[curve.length - 1] as [number, number];
  if (value <= min) return 0;
  if (value >= max) return 100;
  for (let i = 0; i < curve.length - 1; i += 1) {
    const [lowPct, lowMs] = curve[i] as [number, number];
    const [highPct, highMs] = curve[i + 1] as [number, number];
    if (value < highMs) return lowPct + ((highPct - lowPct) * (value - lowMs)) / (highMs - lowMs);
  }
  return 100;
}

function timingFacts(input: FactInput): Candidate[] {
  if (input.testMode || !input.sentAt) return [];
  const out: Candidate[] = [];

  const wait = input.sentAt.getTime() - input.createdAt.getTime();
  if (wait >= QUEUE_WAIT_LONG_MS) out.push(fact("queue", "warn", 70, `Waited ${span(wait)} in the queue before it sent.`));
  else if (wait >= QUEUE_WAIT_NOTABLE_MS) out.push(fact("queue", "neutral", 55, `Waited ${span(wait)} in the queue before it sent.`));
  else if (wait >= 0 && wait < 1000) out.push(fact("queue", "good", 20, `Sent ${span(wait)} after it was accepted.`));

  if (!input.deliveredAt) return out;
  const delivery = input.deliveredAt.getTime() - input.sentAt.getTime();
  if (delivery < 0) return out;

  if (delivery < FAST_DELIVERY_MS) out.push(fact("delivery", "good", 52, `Delivered ${span(delivery)} after it sent.`));
  else if (delivery >= SLOW_DELIVERY_MS) out.push(fact("delivery", "warn", 62, `Took ${span(delivery)} to deliver.`));
  else out.push(fact("delivery", "neutral", 15, `Delivered ${span(delivery)} after it sent.`));

  const compared = comparedDelivery(input, input.sentAt, delivery);
  if (compared) out.push(compared);
  return out;
}

/** Against the domain's last 7 days. Only for a message sent inside or after that window. */
function comparedDelivery(input: FactInput, sentAt: Date, delivery: number): Candidate | null {
  const { stats, domainName } = input;
  if (!stats || stats.deliveredCount < STATS_DELIVERED_FLOOR) return null;
  if (sentAt < stats.deliveryWindowStart) return null;
  const min = stats.deliveryMinMs;
  const max = stats.deliveryMaxMs;
  if (min === null || max === null || min >= max) return null;
  const inWindow = sentAt < stats.computedAt;

  if (delivery >= max) {
    return fact(
      "delivery",
      "warn",
      85,
      inWindow ? `The slowest delivery ${domainName} had this week.` : `Slower than every delivery ${domainName} had this week.`,
    );
  }
  if (delivery <= min) {
    return fact(
      "delivery",
      "good",
      80,
      inWindow ? `The fastest delivery ${domainName} had this week.` : `Faster than every delivery ${domainName} had this week.`,
    );
  }

  const percentile = percentileOf(delivery, stats);
  if (percentile === null) return null;
  if (percentile < 10) {
    const faster = Math.min(99, Math.floor(100 - percentile));
    return fact("delivery", "good", 60 + (10 - percentile) * 2, `Delivered in ${span(delivery)}, faster than ${faster}% of ${domainName}’s mail this week.`);
  }
  if (percentile > 90) {
    const slower = Math.min(99, Math.floor(percentile));
    return fact("delivery", "warn", 60 + (percentile - 90) * 2, `Delivered in ${span(delivery)}, slower than ${slower}% of ${domainName}’s mail this week.`);
  }
  return null;
}

function sendingFacts(input: FactInput): Candidate[] {
  const out: Candidate[] = [];
  if (input.attempts >= 3) out.push(fact("attempts", "warn", 65, `Took ${input.attempts} attempts to send.`));
  else if (input.attempts === 2) out.push(fact("attempts", "neutral", 52, "Sent on the second attempt."));

  const backoffs = input.events
    .filter((event) => event.kind === "backoff")
    .reduce((sum, event) => sum + (typeof event.detail.count === "number" ? event.detail.count : 1), 0);
  if (backoffs > 0) {
    out.push(
      fact(
        "backoff",
        "neutral",
        58 + Math.min(backoffs, 10),
        backoffs === 1 ? "Held once by the provider’s rate limit." : `Held ${count(backoffs)} times by the provider’s rate limit.`,
      ),
    );
  }
  return out;
}

function addressFacts(input: FactInput): Candidate[] {
  const out: Candidate[] = [];
  const { history } = input;
  if (history) {
    if (Math.abs(history.firstSeenAt.getTime() - input.createdAt.getTime()) <= FIRST_SEEN_WITHIN_MS) {
      out.push(fact("address", "neutral", 40, "The first message you’ve sent to this address."));
    }
    // The history counts this message's own outcome too.
    const own = (status: MessageStatus) =>
      input.events.filter((event) => event.kind === "transition" && event.status === status).length;
    const complaints = history.complaintCount - own("complained");
    if (complaints > 0) {
      out.push(
        fact(
          "complaints",
          "warn",
          90,
          complaints === 1 ? "This address marked one other message as spam." : `This address marked ${count(complaints)} other messages as spam.`,
        ),
      );
    }
    const bounces = history.bounceCount - own("bounced");
    if (bounces > 0) out.push(fact("bounces", "warn", 80 + Math.min(bounces, 10), `Mail to this address bounced ${times(bounces)}.`));
  }

  const total = input.messageCount;
  if (total !== null && total >= ADDRESS_COUNT_FLOOR) {
    const magnitude = Math.floor(Math.log10(total));
    const round = total % 10 ** magnitude === 0;
    out.push(
      fact(
        "count",
        "neutral",
        50 + Math.min(15, Math.log10(total / ADDRESS_COUNT_FLOOR) * 10) + (round ? 10 : 0),
        `One of ${count(total)} messages you’ve sent to this address.`,
      ),
    );
  }

  const { fanout } = input;
  if (fanout && fanout.recipients >= 2) {
    const when = fanout.day === input.now.toISOString().slice(0, 10) ? "today" : "that day";
    const score = fanout.recipients >= FANOUT_LARGE ? 68 : fanout.recipients >= FANOUT_FLOOR ? 55 : 25;
    out.push(fact("fanout", "neutral", score, `The same body went to ${count(fanout.recipients)} people from this key ${when}.`));
  }
  return out;
}

/** "a sign-in link" reads "sign-in link". An empty reason is a sensitive message. */
export function sensitiveNoun(reason: string): string {
  return reason.replace(/^(an?|the)\s+/i, "") || "sensitive message";
}

function sensitiveFact(input: FactInput): Candidate | null {
  const { sensitive } = input;
  if (!sensitive || input.testMode) return null;
  const noun = sensitiveNoun(sensitive.reason);
  if (sensitive.day >= SENSITIVE_DAY_ALERT) {
    return fact(
      "sensitive",
      "warn",
      95,
      `The ${formatOrdinal(sensitive.day)} ${noun} to this address in 24 hours. Someone may be targeting this account.`,
    );
  }
  if (sensitive.week < SENSITIVE_WEEK_FLOOR) return null;
  return fact("sensitive", "neutral", 50 + Math.min(sensitive.week, 10), `The ${formatOrdinal(sensitive.week)} ${noun} to this address this week.`);
}

/** Busiest or quietest UTC hour over the domain's last 28 days. Only a strict top or bottom slot counts. */
function hourFact(input: FactInput): Candidate | null {
  const { stats, sentAt, domainName } = input;
  if (!stats || !sentAt || input.testMode || sentAt < stats.volumeWindowStart) return null;
  const slots = stats.hourlyVolume;
  if (slots.length !== 24) return null;
  const total = slots.reduce((sum, n) => sum + n, 0);
  if (total < STATS_VOLUME_FLOOR) return null;

  const mean = total / 24;
  const here = slots[sentAt.getUTCHours()] ?? 0;
  const others = slots.filter((_, hour) => hour !== sentAt.getUTCHours());
  if (here > Math.max(...others) && here >= mean * 1.5) {
    return fact("hour", "neutral", 55, `Sent in ${domainName}’s busiest hour of the day.`);
  }
  if (here < Math.min(...others) && here <= mean * 0.5) {
    return fact("hour", "neutral", 58, `Sent in ${domainName}’s quietest hour of the day.`);
  }
  return null;
}

/**
 * The facts worth showing for one message: the best per topic, notable ones first, up to four.
 * A lone notable fact takes the best ordinary one with it. Nothing notable means nothing.
 */
export function chooseFacts(input: FactInput): MessageFact[] {
  const candidates = [...timingFacts(input), ...sendingFacts(input), ...addressFacts(input)];
  const hour = hourFact(input);
  if (hour) candidates.push(hour);
  const sensitive = sensitiveFact(input);
  if (sensitive) candidates.push(sensitive);

  const best = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const held = best.get(candidate.topic);
    if (!held || candidate.score > held.score) best.set(candidate.topic, candidate);
  }

  const ranked = [...best.values()].sort((a, b) => b.score - a.score);
  const notable = ranked.filter((candidate) => candidate.score >= NOTABLE_SCORE).slice(0, MAX_FACTS);
  if (notable.length === 0) return [];
  const chosen = notable.length === 1 ? [...notable, ...ranked.filter((c) => c.score < NOTABLE_SCORE).slice(0, 1)] : notable;
  return chosen.map(({ text, tone, score }) => ({ text, tone, score }));
}
