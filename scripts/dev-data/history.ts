/**
 * Months of outbound mail, simulated in memory: every send, what the provider said about it,
 * the suppressions it caused and the per-address rollup. Nothing here touches the database.
 */
import type {
  MessageEventKind,
  MessageEventRow,
  MessageRow,
  MessageStatus,
  RecipientHistoryRow,
  SuppressionRow,
} from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import {
  BOUNCES,
  DEFERRALS,
  FAILURES,
  FIRST_NAMES,
  GMAIL_RATE_LIMIT,
  LAST_NAMES,
  MAILBOX_DOMAINS,
  MAILPACE_BOUNCES,
  RETRIES,
  SES_THROTTLE,
  type Body,
  type Template,
} from "./content";
import type { Random } from "./random";

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const ABANDON_MS = DAY;

export interface Sender {
  id: string;
  name: string;
  providerId: string;
  adapter: "ses" | "mailpace";
}

export interface KeyRef {
  id: string;
  name: string;
}

export interface Stream {
  domain: Sender;
  templates: Template[];
  /** `since`/`until` are days ago the key could send. */
  keys: { key: KeyRef; weight: number; since?: number; until?: number }[];
  /** Weekday sends at today's growth. */
  perDay: number;
  /** How much bigger today is than the first day. */
  growth: number;
  weekend: number;
  /** Days ago the stream started. */
  startDay: number;
  /** Share of sends to an address never mailed before. */
  newRate: number;
  /** Share of new addresses that don't exist. */
  badRate: number;
  testMode?: boolean;
  /** Messages created after this sit queued: the domain is stalled. */
  heldFrom?: number;
  /** Share of sends whose provider never reports an outcome. */
  silentRate?: number;
}

export interface Incident {
  /** The provider throttled us: backoff before the send. */
  throttle?: boolean;
  /** The provider's API failed and the worker retried. */
  retry?: boolean;
  /** Gmail rate-limited the receiving side. */
  gmailDefer?: boolean;
}

export interface BatchSend {
  id: string;
  key: string;
  subject: string;
  tags: string[];
  from: string;
  fromName: string;
  body: Body;
}

interface SendSlot {
  kind: "send";
  at: number;
  stream: Stream;
  template: Template;
  key: KeyRef;
  incident?: Incident;
  /** Draws a fresh address from an old list instead of the stream's own audience. */
  stale?: number;
  recipient?: string;
  batch?: BatchSend;
  silent?: boolean;
}

interface ManualSlot {
  kind: "manual";
  at: number;
  detail: string;
}

type Slot = SendSlot | ManualSlot;

interface Planned {
  at: number;
  kind: MessageEventKind;
  status?: MessageStatus;
  reason?: string | null;
  bounceType?: string | null;
  /** Arrived on a provider callback, so it carries the provider's own event id. */
  callback?: boolean;
  detail?: Record<string, unknown>;
}

/** What a body is made of, decided after the simulation picks which rows get their own. */
export interface BodyPlan {
  shared: string;
  name: string;
  body: Body;
  attachment?: Template["attachment"];
}

export interface ManualSuppression {
  id: string;
  address: string;
  detail: string;
  at: number;
}

export interface HistoryResult {
  messages: MessageRow[];
  events: MessageEventRow[];
  suppressions: SuppressionRow[];
  history: RecipientHistoryRow[];
  /** `${domainId}|${hourMs}` → sends refused because a recipient was suppressed. */
  rejections: Map<string, number>;
  bodies: Map<string, BodyPlan>;
  manual: ManualSuppression[];
  /** Rows that always get a body of their own. */
  landmarks: Set<string>;
  /** Rows past retention that keep their key and have no body: "expired". */
  expired: Set<string>;
}

/** A row written out by hand, for the screens that address one message by name. */
export interface ExplicitSpec {
  domain: Sender;
  key: KeyRef;
  status: MessageStatus;
  from: string;
  fromName: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  createdAgo: number;
  body: Body;
  events: [status: MessageStatus, reason: string | null, agoMs: number][];
  providerMessageId?: string;
  attempts?: number;
  testMode?: boolean;
  layout?: boolean;
  tags?: string[];
  attachment?: Template["attachment"];
  nextAttemptAgo?: number;
  bounceType?: string;
  bodyExpired?: boolean;
}

const STALE_DOMAINS: readonly (readonly [string, number])[] = [
  ["aol.com", 5],
  ["comcast.net", 4],
  ["earthlink.net", 2],
  ["att.net", 2],
  ["yahoo.com", 3],
  ["hotmail.com", 3],
  ["gmail.com", 4],
];

/** UTC hours weighted by the Pacific working day. */
const HOUR_WEIGHTS: readonly (readonly [number, number])[] = Array.from({ length: 24 }, (_, hour) => {
  const local = (hour + 17) % 24;
  const weight = local < 6 ? 0.15 : local < 9 ? 0.6 : local < 18 ? 1 : local < 22 ? 0.7 : 0.35;
  return [hour, weight] as const;
});

export class History {
  readonly now: number;
  readonly today: number;
  private readonly random: Random;
  private readonly organizationId: string;
  private readonly slots: Slot[] = [];
  private readonly pools = new Map<Stream, string[]>();
  private readonly bad = new Set<string>();
  private readonly names = new Map<string, string>();
  private readonly used = new Set<string>();
  private readonly suppressedAt = new Map<string, number>();
  private readonly result: HistoryResult = {
    messages: [],
    events: [],
    suppressions: [],
    history: [],
    rejections: new Map(),
    bodies: new Map(),
    manual: [],
    landmarks: new Set(),
    expired: new Set(),
  };
  private counter = 0;
  /** `${domainId}|${week}` → sends and bounces in the guard's two most recent weeks. */
  private readonly weeks = new Map<string, { sends: number; bounces: number }>();

  constructor(random: Random, organizationId: string, now: number) {
    this.random = random;
    this.organizationId = organizationId;
    this.now = now;
    this.today = Math.floor(now / DAY) * DAY;
  }

  /** Midnight UTC, `days` ago. */
  dayStart(days: number): number {
    return this.today - days * DAY;
  }

  /** A fresh address. `stale` is the share that no longer exists. */
  address(badRate: number, domains: readonly (readonly [string, number])[] = MAILBOX_DOMAINS): string {
    for (;;) {
      const first = this.random.pick(FIRST_NAMES);
      const last = this.random.pick(LAST_NAMES);
      const domain = this.random.weighted(domains);
      const consumer = !domain.includes(".") || /gmail|outlook|icloud|yahoo|hotmail|proton|fastmail|aol|comcast|earthlink|att/.test(domain);
      const local = consumer
        ? this.random.weighted<string>([
            [`${first}.${last}`, 4],
            [`${first}${last}${this.random.int(1, 99)}`, 3],
            [`${first[0]}${last}`, 2],
            [`${first}.${last}${this.random.int(70, 99)}`, 1],
          ])
        : this.random.weighted<string>([
            [first, 4],
            [`${first}.${last}`, 4],
            [`${first[0]}.${last}`, 2],
          ]);
      const address = `${local}@${domain}`;
      if (this.used.has(address)) continue;
      this.used.add(address);
      this.names.set(address, first.charAt(0).toUpperCase() + first.slice(1));
      if (this.random.chance(badRate)) this.bad.add(address);
      return address;
    }
  }

  /** Addresses an audience already knows, so the first send to them isn't a first contact. */
  seedPool(stream: Stream, addresses: string[]): void {
    this.pools.set(stream, [...(this.pools.get(stream) ?? []), ...addresses]);
  }

  nameOf(address: string): string {
    return this.names.get(address) ?? "there";
  }

  isSuppressed(address: string): boolean {
    return this.suppressedAt.has(address);
  }

  /** Every day's sends for one stream. */
  schedule(stream: Stream, options: { extra?: (day: number, weekday: number) => { template: Template; count: number } | null } = {}): void {
    for (let day = stream.startDay; day >= 0; day -= 1) {
      const start = this.dayStart(day);
      const weekday = new Date(start + 12 * HOUR).getUTCDay();
      const weekend = weekday === 0 || weekday === 6;
      const growth = (1 + stream.growth * (1 - day / 180)) / (1 + stream.growth);
      const expected = stream.perDay * growth * (weekend ? stream.weekend : 1) * (0.8 + 0.4 * this.random.next());
      const count = Math.round(expected);
      for (let i = 0; i < count; i += 1) this.send(stream, this.timeOfDay(start), this.random.weighted(stream.templates.map((t) => [t, t.weight])));
      const extra = options.extra?.(day, weekday);
      if (extra) for (let i = 0; i < extra.count; i += 1) this.send(stream, this.timeOfDay(start), extra.template);
    }
  }

  /** One send in the plan. Times past now are dropped. */
  send(stream: Stream, at: number, template: Template, extra: Partial<Omit<SendSlot, "kind" | "at" | "stream" | "template">> = {}): void {
    if (at > this.now - 5 * SECOND) return;
    const day = Math.floor((this.today - Math.floor(at / DAY) * DAY) / DAY);
    const keys = stream.keys.filter((entry) => (entry.since ?? Infinity) >= day && (entry.until ?? -1) < day);
    if (keys.length === 0) return;
    const key = extra.key ?? this.random.weighted(keys.map((entry) => [entry.key, entry.weight]));
    this.slots.push({ kind: "send", at, stream, template, ...extra, key });
  }

  manual(at: number, detail: string): void {
    this.slots.push({ kind: "manual", at, detail });
  }

  /** Stamps every slot in a window with an incident. */
  incident(domainId: string, from: number, until: number, incident: Incident): void {
    for (const slot of this.slots) {
      if (slot.kind === "send" && slot.stream.domain.id === domainId && slot.at >= from && slot.at < until) {
        slot.incident = { ...slot.incident, ...incident };
      }
    }
  }

  /** Marks a handful of recent sends from a domain as never hearing back. */
  silence(domainId: string, from: number, until: number, count: number): void {
    const candidates = this.slots.filter(
      (slot): slot is SendSlot => slot.kind === "send" && slot.stream.domain.id === domainId && slot.at >= from && slot.at < until && !slot.batch,
    );
    for (let i = 0; i < count && candidates.length > 0; i += 1) {
      const [slot] = candidates.splice(this.random.int(0, candidates.length - 1), 1);
      if (slot) slot.silent = true;
    }
  }

  timeOfDay(start: number): number {
    return start + this.random.weighted(HOUR_WEIGHTS) * HOUR + Math.floor(this.random.next() * HOUR);
  }

  /** Runs the plan in time order, so a suppression only stops the sends after it. */
  run(): HistoryResult {
    this.slots.sort((a, b) => a.at - b.at);
    for (const slot of this.slots) {
      if (slot.kind === "manual") this.runManual(slot);
      else this.runSend(slot);
    }
    this.result.history = this.rollup();
    return this.result;
  }

  private runManual(slot: ManualSlot): void {
    const pools = [...this.pools.values()].filter((pool) => pool.length > 0);
    if (pools.length === 0) return;
    const pool = this.random.pick(pools);
    const address = pool[this.random.int(0, pool.length - 1)]!;
    if (this.suppressedAt.has(address)) return;
    const id = newId("suppression");
    this.suppressedAt.set(address, slot.at);
    this.result.suppressions.push(this.suppressionRow({ id, address, reason: "manual", detail: slot.detail, at: slot.at }));
    this.result.manual.push({ id, address, detail: slot.detail, at: slot.at });
  }

  private pickRecipient(slot: SendSlot): string {
    if (slot.recipient) return slot.recipient;
    if (slot.stale !== undefined) return this.address(slot.stale, STALE_DOMAINS);
    const pool = this.pools.get(slot.stream) ?? [];
    this.pools.set(slot.stream, pool);
    if (pool.length < 20 || this.random.chance(slot.stream.newRate)) {
      const address = this.address(slot.stream.badRate);
      pool.push(address);
      return address;
    }
    // Recent signups are the busiest.
    return pool[Math.floor(pool.length * (1 - this.random.next() ** 2.2))]!;
  }

  private runSend(slot: SendSlot): void {
    const recipient = this.pickRecipient(slot);
    const suppressed = this.suppressedAt.get(recipient);
    if (suppressed !== undefined && suppressed <= slot.at) {
      if (slot.at >= this.now - 2 * DAY && !slot.stream.testMode) {
        const key = `${slot.stream.domain.id}|${Math.floor(slot.at / HOUR) * HOUR}`;
        this.result.rejections.set(key, (this.result.rejections.get(key) ?? 0) + 1);
      }
      return;
    }
    this.simulate(slot, recipient);
  }

  private providerMessageId(slot: SendSlot): string {
    if (slot.stream.testMode) return `mock_${this.random.hex(10)}`;
    if (slot.stream.domain.adapter === "mailpace") return `mp_${this.random.hex(10)}`;
    const r = this.random;
    return `0100019${r.hex(9)}-${r.hex(8)}-${r.hex(4)}-${r.hex(4)}-${r.hex(4)}-${r.hex(12)}-000000`;
  }

  private providerEventId(adapter: Sender["adapter"]): string {
    this.counter += 1;
    return adapter === "ses" ? `${this.random.hex(8)}-${this.random.hex(4)}-${this.counter.toString(36)}` : `evt_${this.random.hex(12)}`;
  }

  private bounceReason(slot: SendSlot): { reason: string; bounceType: string | null } {
    if (slot.stream.domain.adapter === "mailpace") return { reason: this.random.weighted(MAILPACE_BOUNCES), bounceType: null };
    const [reason, bounceType] = this.random.weighted(BOUNCES.map(([r, t, w]) => [[r, t] as const, w]));
    return { reason, bounceType };
  }

  /** One message's whole life, then everything after now cut off. */
  private simulate(slot: SendSlot, recipient: string): void {
    const r = this.random;
    const { stream, template } = slot;
    const domain = stream.domain;
    const id = newId("message");
    const t0 = slot.at;
    const incident = slot.incident ?? {};
    const planned: Planned[] = [];
    planned.push({ at: t0, kind: "transition", status: "queued" });

    let attempts = 1;
    let abandoned: number | null = null;
    let nextAttemptAt = t0;
    const held = stream.heldFrom !== undefined && t0 >= stream.heldFrom;

    const retries = incident.retry ? r.weighted([[0, 35], [1, 40], [2, 25]]) : r.chance(0.003) ? 1 : 0;
    const queueMs =
      (incident.throttle ? r.lognormal(6 * MINUTE, 0.8) : r.chance(0.01) ? r.int(30 * SECOND, 4 * MINUTE) : r.lognormal(700, 0.9)) +
      retries * r.lognormal(40 * SECOND, 0.5);
    const sentAt = Math.round(t0 + queueMs);

    if (!held) {
      if (incident.throttle) {
        planned.push({ at: t0 + queueMs * 0.1, kind: "backoff", reason: SES_THROTTLE, detail: { until: new Date(sentAt).toISOString(), count: r.int(1, 6) } });
      }
      for (let i = 0; i < retries; i += 1) {
        const at = t0 + (queueMs * (i + 1)) / (retries + 2);
        const reason = r.weighted(RETRIES);
        planned.push({ at, kind: "retry", reason, detail: { attempt: i + 1, nextAttemptAt: new Date(t0 + (queueMs * (i + 2)) / (retries + 2)).toISOString() } });
      }
      attempts = retries + 1;

      if (!stream.testMode && r.chance(0.0025)) {
        planned.push({ at: sentAt, kind: "transition", status: "failed", reason: r.weighted(FAILURES) });
      } else if (slot.silent || (stream.silentRate && r.chance(stream.silentRate))) {
        // The provider took it and never said another word.
        planned.push({ at: sentAt, kind: "transition", status: "sent" });
        if (sentAt + ABANDON_MS <= this.now) {
          abandoned = sentAt + ABANDON_MS + r.int(30 * SECOND, 10 * MINUTE);
          planned.push({ at: abandoned, kind: "abandoned", detail: { thresholdMs: ABANDON_MS } });
        }
      } else {
        planned.push({ at: sentAt, kind: "transition", status: "sent" });
        this.afterSend(slot, recipient, sentAt, incident, planned);
      }
    }

    // Everything the clock hasn't reached yet didn't happen.
    const events = planned.filter((event) => event.at <= this.now).sort((a, b) => a.at - b.at);
    let status: MessageStatus = "queued";
    let sent: number | null = null;
    let delivered: number | null = null;
    let lastReason: string | null = null;
    for (const event of events) {
      if (event.kind === "retry") lastReason = event.reason ?? null;
      if (event.kind !== "transition" || !event.status) continue;
      status = event.status;
      if (event.status === "sent") sent = event.at;
      if (event.status === "delivered") delivered = event.at;
      lastReason = event.status === "sent" || event.status === "delivered" || event.status === "queued" ? null : (event.reason ?? null);
    }
    if (status === "queued") {
      if (held) {
        attempts = 0;
        nextAttemptAt = this.now + r.int(10 * SECOND, 2 * MINUTE);
      } else {
        // Waiting out a retry or a backoff, or not claimed yet.
        attempts = events.filter((event) => event.kind === "retry").length;
        nextAttemptAt = sentAt;
      }
    }

    const from = slot.batch?.from ?? template.from;
    const fromName = slot.batch?.fromName ?? template.fromName;
    const updated = events.length > 0 ? events[events.length - 1]!.at : t0;
    const row: MessageRow = {
      id,
      organizationId: this.organizationId,
      domainId: domain.id,
      apiKeyId: slot.key.id,
      batchId: slot.batch?.id ?? null,
      status,
      fromAddress: from,
      recipients: [recipient],
      subject: slot.batch?.subject ?? template.subject(r),
      envelope: {
        from,
        fromName,
        to: [recipient],
        cc: [],
        bcc: [],
        replyTo: [],
        headers: {},
        attachmentCount: template.attachment && !slot.batch ? 1 : 0,
      },
      tags: slot.batch?.tags ?? template.tags,
      warnings: [],
      storageKey: null,
      bodyKey: null,
      testMode: stream.testMode ?? false,
      layout: template.layout ?? false,
      layoutOverrides: null,
      providerId: sent === null ? null : domain.providerId,
      providerMessageId: sent === null ? null : this.providerMessageId(slot),
      failureReason: lastReason,
      attempts: status === "queued" ? attempts : Math.max(attempts, 1),
      lastAttemptAt: status === "queued" && attempts === 0 ? null : new Date(Math.min(sentAt, this.now) - 150),
      nextAttemptAt: new Date(nextAttemptAt),
      lockedAt: null,
      lockedBy: null,
      requestId: slot.batch ? null : `req_${r.hex(20)}`,
      idempotencyKey: null,
      requestHash: null,
      // Set with the body, in scripts/dev-data.ts.
      bodyHash: null,
      bodyBytes: null,
      attachmentBytes: null,
      linkListings: null,
      sentAt: sent === null ? null : new Date(sent),
      deliveredAt: delivered === null ? null : new Date(delivered),
      abandonedAt: abandoned !== null && abandoned <= this.now ? new Date(abandoned) : null,
      bodyWithheld: null,
      resentFrom: null,
      bodyPurgedAt: null,
      createdAt: new Date(t0),
      updatedAt: new Date(updated),
    };
    this.result.messages.push(row);
    this.result.bodies.set(id, {
      shared: slot.batch?.id ?? `${domain.name}:${template.key}`,
      name: this.nameOf(recipient),
      body: slot.batch?.body ?? template.body("there"),
      attachment: slot.batch ? undefined : template.attachment,
    });

    let previous = 0;
    for (const event of events) {
      // Strictly increasing, so the timeline never ties.
      const at = Math.max(Math.round(event.at), previous + 1);
      previous = at;
      const eventId = newId("event");
      this.result.events.push({
        id: eventId,
        organizationId: this.organizationId,
        messageId: id,
        kind: event.kind,
        status: event.kind === "transition" ? (event.status ?? null) : null,
        reason: event.reason ?? null,
        bounceType: event.bounceType ?? null,
        providerId: event.callback ? domain.providerId : null,
        providerEventId: event.callback ? this.providerEventId(domain.adapter) : null,
        detail: event.detail ?? {},
        occurredAt: new Date(at),
        createdAt: new Date(at + (event.callback ? r.int(50, 2000) : 0)),
      });

      // A hard bounce or complaint suppresses the address across every domain.
      if (!stream.testMode && event.kind === "transition" && (event.status === "bounced" || event.status === "complained")) {
        if (!this.suppressedAt.has(recipient)) {
          this.suppressedAt.set(recipient, at);
          this.result.suppressions.push(
            this.suppressionRow({
              id: newId("suppression"),
              address: recipient,
              reason: event.status === "bounced" ? "hard_bounce" : "complaint",
              detail: event.reason ?? null,
              bounceType: event.status === "bounced" ? (event.bounceType ?? null) : null,
              sourceMessageId: id,
              at,
            }),
          );
          previous = at + 1;
          this.result.events.push({
            id: newId("event"),
            organizationId: this.organizationId,
            messageId: id,
            kind: "suppressed",
            status: null,
            reason: null,
            bounceType: null,
            providerId: null,
            providerEventId: null,
            detail: { address: recipient, suppressionReason: event.status === "bounced" ? "hard_bounce" : "complaint" },
            occurredAt: new Date(previous),
            createdAt: new Date(previous),
          });
        }
      }
    }
  }

  /**
   * The guard's week, for a healthy domain's last two weeks. The stall guard and standing read
   * rates on a few hundred sends, where two stray bounces read as a trend.
   */
  private week(domainId: string, at: number): { sends: number; bounces: number } | null {
    if (at < this.now - 14 * DAY) return null;
    const key = `${domainId}|${at >= this.now - 7 * DAY ? 0 : 1}`;
    const week = this.weeks.get(key) ?? { sends: 0, bounces: 0 };
    this.weeks.set(key, week);
    return week;
  }

  /** What the receiving side did once the provider had it. */
  private afterSend(slot: SendSlot, recipient: string, sentAt: number, incident: Incident, planned: Planned[]): void {
    const r = this.random;
    const { stream } = slot;
    const ses = stream.domain.adapter === "ses";
    const isBad = this.bad.has(recipient);
    let bounceRoll = stream.testMode ? recipient.startsWith("bounce") : isBad || r.chance(slot.batch ? 0.0003 : 0.0004);

    // Healthy domains bounce at a steady 0.6% in the weeks the guard reads, so noise doesn't read as a trend.
    const week = stream.testMode || stream.heldFrom !== undefined ? null : this.week(stream.domain.id, slot.at);
    if (week) {
      week.sends += 1;
      bounceRoll = week.bounces < Math.round(week.sends * 0.006);
      if (bounceRoll) week.bounces += 1;
    }

    if (bounceRoll) {
      const { reason, bounceType } = stream.testMode ? { reason: "550 5.1.1 Simulated hard bounce.", bounceType: null } : this.bounceReason(slot);
      const delay = r.chance(0.7) ? r.lognormal(3 * SECOND, 0.8) : r.lognormal(20 * MINUTE, 1.2);
      planned.push({ at: sentAt + delay, kind: "transition", status: "bounced", reason, bounceType, callback: true });
      return;
    }

    let at = sentAt;
    const gmail = recipient.endsWith("@gmail.com");
    const deferred = (incident.gmailDefer && gmail && r.chance(0.6)) || r.chance(slot.batch ? 0.015 : 0.025);
    if (deferred) {
      const rounds = r.weighted([[1, 60], [2, 30], [3, 10]]);
      for (let i = 0; i < rounds; i += 1) {
        at += i === 0 ? r.int(20 * SECOND, 5 * MINUTE) : r.lognormal(25 * MINUTE, 0.9);
        const reason = incident.gmailDefer && gmail ? GMAIL_RATE_LIMIT : r.weighted(DEFERRALS);
        planned.push({ at, kind: "transition", status: "deferred", reason, callback: true });
      }
      at += r.lognormal(35 * MINUTE, 1);
    } else {
      at += r.chance(0.02) ? r.int(MINUTE, 15 * MINUTE) : r.lognormal(ses ? 2500 : 4000, 1.1);
    }
    planned.push({ at, kind: "transition", status: "delivered", reason: null, callback: true });

    const complaintRate = slot.batch ? 0.0009 : 0.00035;
    const complaintAt = at + r.int(2 * HOUR, 3 * DAY);
    const allowed = stream.heldFrom !== undefined || complaintAt < this.now - 8 * DAY;
    if (!stream.testMode && allowed && r.chance(complaintRate)) {
      planned.push({ at: complaintAt, kind: "transition", status: "complained", reason: ses ? "abuse" : "Recipient marked the message as spam.", callback: true });
    }
  }

  private suppressionRow(input: {
    id: string;
    address: string;
    reason: SuppressionRow["reason"];
    detail: string | null;
    bounceType?: string | null;
    sourceMessageId?: string | null;
    source?: string | null;
    at: number;
  }): SuppressionRow {
    return {
      id: input.id,
      organizationId: this.organizationId,
      address: input.address,
      reason: input.reason,
      detail: input.detail,
      bounceType: input.bounceType ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      source: input.source ?? null,
      createdAt: new Date(input.at),
    };
  }

  /** Writes one landmark row as specified, bypassing the simulation. */
  explicit(spec: ExplicitSpec): string {
    const id = newId("message");
    const createdAt = this.now - spec.createdAgo;
    const sent = spec.events.find(([status]) => status === "sent");
    const delivered = spec.events.find(([status]) => status === "delivered");
    const terminal = [...spec.events].reverse().find(([status]) => status !== "queued" && status !== "sent" && status !== "delivered");
    const last = spec.events[spec.events.length - 1];
    const recipients = [spec.to, ...(spec.cc ?? []), ...(spec.bcc ?? [])];
    this.result.messages.push({
      id,
      organizationId: this.organizationId,
      domainId: spec.domain.id,
      apiKeyId: spec.key.id,
      batchId: null,
      status: spec.status,
      fromAddress: spec.from,
      recipients,
      subject: spec.subject,
      envelope: {
        from: spec.from,
        fromName: spec.fromName,
        to: [spec.to],
        cc: spec.cc ?? [],
        bcc: spec.bcc ?? [],
        replyTo: [],
        headers: {},
        attachmentCount: spec.attachment ? 1 : 0,
      },
      tags: spec.tags ?? [],
      warnings: [],
      storageKey: null,
      bodyKey: null,
      testMode: spec.testMode ?? false,
      layout: spec.layout ?? false,
      layoutOverrides: null,
      providerId: sent ? spec.domain.providerId : null,
      providerMessageId: spec.providerMessageId ?? null,
      failureReason: terminal?.[1] ?? null,
      attempts: spec.attempts ?? 1,
      lastAttemptAt: sent ? new Date(this.now - sent[2] - 150) : null,
      nextAttemptAt: new Date(spec.nextAttemptAgo === undefined ? createdAt : this.now - spec.nextAttemptAgo),
      lockedAt: null,
      lockedBy: null,
      requestId: `req_${this.random.hex(20)}`,
      idempotencyKey: null,
      requestHash: null,
      bodyHash: null,
      bodyBytes: null,
      attachmentBytes: null,
      linkListings: null,
      sentAt: sent ? new Date(this.now - sent[2]) : null,
      deliveredAt: delivered ? new Date(this.now - delivered[2]) : null,
      abandonedAt: null,
      bodyWithheld: null,
      resentFrom: null,
      bodyPurgedAt: null,
      createdAt: new Date(createdAt),
      updatedAt: new Date(last ? this.now - last[2] : createdAt),
    });
    this.result.bodies.set(id, { shared: id, name: this.nameOf(spec.to), body: spec.body, attachment: spec.attachment });
    if (spec.bodyExpired) this.result.expired.add(id);
    else this.result.landmarks.add(id);

    for (const [status, reason, agoMs] of spec.events) {
      const at = this.now - agoMs;
      const callback = status !== "queued" && status !== "sent" && status !== "failed" && !spec.testMode;
      this.result.events.push({
        id: newId("event"),
        organizationId: this.organizationId,
        messageId: id,
        kind: "transition",
        status,
        reason,
        bounceType: status === "bounced" ? (spec.bounceType ?? null) : null,
        providerId: callback ? spec.domain.providerId : null,
        providerEventId: callback ? this.providerEventId(spec.domain.adapter) : null,
        detail: {},
        occurredAt: new Date(at),
        createdAt: new Date(at),
      });
      if (status === "bounced" && !spec.testMode) {
        const week = this.week(spec.domain.id, createdAt);
        if (week) week.bounces += 1;
      }
      if ((status === "bounced" || status === "complained") && !spec.testMode && !this.suppressedAt.has(spec.to)) {
        this.suppressedAt.set(spec.to, at);
        this.result.suppressions.push(
          this.suppressionRow({
            id: newId("suppression"),
            address: spec.to,
            reason: status === "bounced" ? "hard_bounce" : "complaint",
            detail: reason,
            bounceType: status === "bounced" ? (spec.bounceType ?? null) : null,
            sourceMessageId: id,
            at,
          }),
        );
      }
    }
    return id;
  }

  /** A suppression with no send behind it: an import, a manual add. The address never sends after `at`. */
  suppressDirect(input: { address: string; reason: SuppressionRow["reason"]; detail: string; source?: string; at: number }): string {
    const id = newId("suppression");
    this.suppressedAt.set(input.address, input.at);
    this.result.suppressions.push(this.suppressionRow({ id, ...input }));
    return id;
  }

  /** Per-address rollup, the way `lib/messages/history.ts` keeps it as events land. */
  private rollup(): RecipientHistoryRow[] {
    const byMessage = new Map<string, MessageEventRow[]>();
    for (const event of this.result.events) {
      if (event.kind !== "transition") continue;
      const list = byMessage.get(event.messageId) ?? [];
      list.push(event);
      byMessage.set(event.messageId, list);
    }
    const rows = new Map<string, RecipientHistoryRow>();
    const ordered = [...this.result.messages].filter((m) => !m.testMode).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const message of ordered) {
      for (const address of message.recipients) {
        const row =
          rows.get(address) ??
          ({
            organizationId: this.organizationId,
            address,
            firstSeenAt: message.createdAt,
            lastDeliveredAt: null,
            lastBouncedAt: null,
            bounceCount: 0,
            lastComplainedAt: null,
            complaintCount: 0,
            lastDeferredAt: null,
            deferredCount: 0,
            updatedAt: message.createdAt,
          } satisfies RecipientHistoryRow);
        for (const event of byMessage.get(message.id) ?? []) {
          if (event.status === "delivered") {
            row.lastDeliveredAt = event.occurredAt;
            row.deferredCount = 0;
          } else if (event.status === "bounced") {
            row.lastBouncedAt = event.occurredAt;
            row.bounceCount += 1;
          } else if (event.status === "complained") {
            row.lastComplainedAt = event.occurredAt;
            row.complaintCount += 1;
          } else if (event.status === "deferred") {
            row.lastDeferredAt = event.occurredAt;
            row.deferredCount += 1;
          } else continue;
          if (event.occurredAt > row.updatedAt) row.updatedAt = event.occurredAt;
        }
        rows.set(address, row);
      }
    }
    return [...rows.values()];
  }
}
