/** Lists and batches, inbound mail, webhooks and the activity log around the generated history. */
import type {
  BatchRow,
  InboundMessageRow,
  ListMembershipRow,
  ListRow,
  MessageEventRow,
  MessageRow,
  WebhookDeliveryRow,
  WebhookEndpointRow,
  WebhookEventType,
  activity,
  webhookAttempts,
} from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { familyFor, outcomeFor } from "@/lib/activity/taxonomy";
import { serializeMessage } from "@/lib/messages/serialize";
import { serializeInboundMessage } from "@/lib/inbound/serialize";
import { encrypt } from "@/lib/crypto";
import type { ActivityActor } from "@/lib/activity/types";
import { FIRST_NAMES, type BatchTemplate, type Template } from "./content";
import { DAY, HOUR, MINUTE, SECOND, type History, type KeyRef, type Sender, type Stream } from "./history";
import type { Random } from "./random";

/* ----------------------------------------------------------------- lists --- */

export interface ListSpec {
  domain: Sender;
  name: string;
  doubleOptIn: boolean;
  /** Days ago the list was made. */
  createdDay: number;
  /** Members brought in by an import on day one. */
  imported: number;
  /** Members who signed up since. */
  signups: number;
  unsubscribeRate: number;
  manual: number;
  batch: { template: BatchTemplate; days: number[]; key: KeyRef; stream: Stream };
}

export interface ListPlan {
  list: ListRow;
  members: ListMembershipRow[];
  batches: BatchRow[];
}

export function planList(history: History, random: Random, organizationId: string, spec: ListSpec, actorLabel: string): ListPlan {
  const now = history.now;
  const listId = newId("list");
  const createdAt = history.dayStart(spec.createdDay) + 17 * HOUR;
  const members: ListMembershipRow[] = [];
  const attributes = () => ({ first_name: random.pick(FIRST_NAMES).replace(/^./, (c) => c.toUpperCase()), plan: random.weighted([["free", 6], ["plus", 3], ["team", 1]]) });

  const member = (at: number, source: ListMembershipRow["source"], address: string): ListMembershipRow => {
    const confirmed = source === "import" || !spec.doubleOptIn ? at : at + random.lognormal(20 * MINUTE, 1.2);
    return {
      id: newId("listMembership"),
      organizationId,
      listId,
      address,
      status: "subscribed",
      source,
      sourceMessageId: null,
      manualActor: source === "manual" ? actorLabel : null,
      attributes: attributes(),
      doubleOptIn: spec.doubleOptIn,
      confirmedAt: new Date(confirmed),
      confirmedBy: source === "import" ? "import" : spec.doubleOptIn ? "link" : "not_required",
      pendingExpiresAt: null,
      confirmationSentAt: spec.doubleOptIn && source === "api" ? new Date(at + 4 * SECOND) : null,
      confirmationAttempts: spec.doubleOptIn && source === "api" ? 1 : 0,
      unsubscribedAt: null,
      createdAt: new Date(at),
      updatedAt: new Date(confirmed),
    };
  };

  for (let i = 0; i < spec.imported; i += 1) members.push(member(createdAt + i * 20, "import", history.address(0.012)));
  for (let i = 0; i < spec.signups; i += 1) {
    // Signups pick up as the list gets around.
    const at = createdAt + (now - createdAt - HOUR) * Math.sqrt(random.next());
    members.push(member(at, "api", history.address(0.002)));
  }
  for (let i = 0; i < spec.manual; i += 1) {
    members.push(member(createdAt + (now - createdAt) * random.next(), "manual", history.address(0)));
  }

  for (const row of members) {
    const confirmed = row.confirmedAt!.getTime();
    // Double opt-in signups that never clicked stay pending; the older ones have expired.
    if (spec.doubleOptIn && row.source === "api" && confirmed > now - 12 * DAY && random.chance(0.35)) {
      row.status = "pending";
      row.confirmedAt = null;
      row.confirmedBy = null;
      row.pendingExpiresAt = new Date(row.createdAt.getTime() + 7 * DAY);
      row.updatedAt = row.createdAt;
      continue;
    }
    if (random.chance(spec.unsubscribeRate)) {
      const at = confirmed + (now - confirmed) * random.next();
      row.status = "unsubscribed";
      row.unsubscribedAt = new Date(at);
      row.updatedAt = row.unsubscribedAt;
    }
  }

  const subscribedAt = (row: ListMembershipRow, at: number) =>
    row.confirmedAt !== null && row.confirmedAt.getTime() <= at && (row.unsubscribedAt === null || row.unsubscribedAt.getTime() > at);

  const batches: BatchRow[] = [];
  const template = spec.batch.template;
  spec.batch.days.forEach((day, index) => {
    const at = history.dayStart(day) + 16 * HOUR + random.int(0, 20) * MINUTE;
    if (at >= now - 10 * MINUTE) return;
    const known = members.filter((row) => row.createdAt.getTime() <= at);
    const recipients = known.filter((row) => subscribedAt(row, at));
    const batchId = newId("batch");
    const subject = template.subject(spec.batch.days.length - index);
    batches.push({
      id: batchId,
      organizationId,
      domainId: spec.domain.id,
      apiKeyId: spec.batch.key.id,
      listId,
      fromAddress: template.from,
      subject,
      tags: template.tags,
      recipientCount: recipients.length,
      skippedCount: known.length - recipients.length,
      createdAt: new Date(at),
    });
    const asTemplate: Template = {
      key: template.key,
      weight: 1,
      from: template.from,
      fromName: template.fromName,
      tags: template.tags,
      subject: () => subject,
      body: () => template.body,
    };
    recipients.forEach((row, i) => {
      history.send(spec.batch.stream, at + i * random.int(90, 220), asTemplate, {
        key: spec.batch.key,
        recipient: row.address,
        batch: { id: batchId, key: `${template.key}:${batchId}`, subject, tags: template.tags, from: template.from, fromName: template.fromName, body: template.body },
      });
    });
  });

  return {
    list: { id: listId, organizationId, domainId: spec.domain.id, name: spec.name, doubleOptIn: spec.doubleOptIn, createdAt: new Date(createdAt), updatedAt: new Date(createdAt) },
    members,
    batches,
  };
}

/* --------------------------------------------------------------- inbound --- */

export interface InboundSpec {
  domain: Sender;
  host: string;
  days: number;
  perDay: number;
  retentionDays: number;
  /** Outbound mail a reply can answer. */
  outbound: MessageRow[];
}

const SUPPORT_SUBJECTS = ["Can't sign in", "Question about my invoice", "Feature request: export to CSV", "Change the email on my account", "Is there an API rate limit?", "Cancel my plan"];
const SPAM_SUBJECTS = ["Boost your domain authority today", "Invoice overdue — action required", "Partnership opportunity"];

export function planInbound(history: History, random: Random, organizationId: string, spec: InboundSpec): InboundMessageRow[] {
  const rows: InboundMessageRow[] = [];
  const replyable = spec.outbound.filter((m) => m.status === "delivered" && m.providerMessageId && m.createdAt.getTime() > history.now - spec.days * DAY);
  for (let day = spec.days - 1; day >= 0; day -= 1) {
    const count = Math.round(spec.perDay * (0.5 + random.next()));
    for (let i = 0; i < count; i += 1) {
      const receivedAt = history.timeOfDay(history.dayStart(day));
      if (receivedAt > history.now - MINUTE) continue;
      const kind = random.weighted<"reply" | "support" | "auto" | "spam">([["reply", 50], ["support", 30], ["auto", 14], ["spam", 6]]);
      const answered = kind === "reply" || kind === "auto" ? replyable.filter((m) => m.deliveredAt && m.deliveredAt.getTime() < receivedAt) : [];
      const original = answered.length > 0 ? answered[random.int(Math.max(0, answered.length - 200), answered.length - 1)] : undefined;
      const from = original?.recipients[0] ?? history.address(0);
      const name = history.nameOf(from);
      const subject =
        kind === "spam" ? random.pick(SPAM_SUBJECTS) : kind === "support" ? random.pick(SUPPORT_SUBJECTS) : `${kind === "auto" ? "Automatic reply: " : "Re: "}${original?.subject ?? "Your message"}`;
      const text =
        kind === "auto"
          ? `I'm out of the office until Monday with limited access to email.\n\n${name}`
          : kind === "spam"
            ? "Dear Sir/Madam, we can get your site to the first page of Google in 30 days. Reply for pricing."
            : kind === "support"
              ? `Hi, ${subject.toLowerCase()} — can you help?\n\nThanks,\n${name}`
              : `Thanks, that worked.\n\n${name}\n\nOn ${original?.createdAt.toUTCString()}, ${original?.envelope.fromName ?? ""} wrote:\n> ...`;
      const messageId = `<${random.hex(24)}@${from.split("@")[1]}>`;
      const inReplyTo = original?.providerMessageId ? `<${original.providerMessageId}@${spec.domain.adapter === "ses" ? "us-west-2.amazonses.com" : "mailpace.com"}>` : null;
      const pass = kind === "spam" ? "FAIL" : "PASS";
      const withAttachment = kind === "support" && random.chance(0.2);
      rows.push({
        id: newId("inbound"),
        organizationId,
        domainId: spec.domain.id,
        providerMessageId: spec.domain.adapter === "ses" ? random.hex(32) : `mp_in_${random.hex(10)}`,
        fromAddress: from,
        fromName: kind === "spam" ? "SEO Team" : name,
        to: [`${kind === "support" || kind === "spam" ? "support" : "replies"}@${spec.host}`],
        subject,
        text,
        html: kind === "reply" || kind === "support" ? null : `<p>${text.replace(/\n/g, "<br>")}</p>`,
        // Sealed after insert by sealLegacyInbound, the way production's backfill does it.
        bodyKey: null,
        storageKey: null,
        headers: { "Message-Id": messageId, Subject: subject, ...(inReplyTo ? { "In-Reply-To": inReplyTo } : {}) },
        messageId,
        inReplyTo,
        outboundMessageId: kind === "reply" || kind === "auto" ? (original?.id ?? null) : null,
        // A flagged attachment isn't kept, so it has no storage key.
        attachments: withAttachment ? [{ filename: "screenshot.png", contentType: "image/png", size: random.int(80_000, 900_000), storageKey: null }] : [],
        rawStorageKey: null,
        addressIds: [],
        threadId: newId("thread"),
        verdicts: spec.domain.adapter === "ses" ? { spam: pass, virus: withAttachment ? "FAIL" : "PASS", spf: pass, dkim: kind === "spam" ? "GRAY" : "PASS", dmarc: pass } : null,
        receivedAt: new Date(receivedAt),
        expiresAt: new Date(receivedAt + spec.retentionDays * DAY),
        createdAt: new Date(receivedAt + random.int(200, 3000)),
      });
    }
  }
  return rows;
}

/* -------------------------------------------------------------- webhooks --- */

export interface WebhookPlan {
  endpoints: WebhookEndpointRow[];
  deliveries: WebhookDeliveryRow[];
  attempts: (typeof webhookAttempts.$inferInsert)[];
  events: MessageEventRow[];
}

interface EndpointSpec {
  url: string;
  events: WebhookEventType[];
  description: string;
  key?: KeyRef;
  domain?: Sender;
  createdAgo: number;
  /** Receiver answered with this for every delivery, until the endpoint was turned off. */
  broken?: { status: number; error: string; disabledAgo: number };
}

const STATUS_EVENT: Partial<Record<string, WebhookEventType>> = {
  delivered: "email.delivered",
  bounced: "email.bounced",
  complained: "email.complained",
};

export function planWebhooks(
  history: History,
  random: Random,
  organizationId: string,
  specs: EndpointSpec[],
  messages: MessageRow[],
  events: MessageEventRow[],
  inbound: InboundMessageRow[],
): WebhookPlan {
  const plan: WebhookPlan = { endpoints: [], deliveries: [], attempts: [], events: [] };
  const now = history.now;
  const messagesById = new Map(messages.map((m) => [m.id, m]));

  for (const spec of specs) {
    const endpoint: WebhookEndpointRow = {
      id: newId("webhookEndpoint"),
      organizationId,
      apiKeyId: spec.key?.id ?? null,
      domainId: spec.domain?.id ?? null,
      url: spec.url,
      events: spec.events,
      description: spec.description,
      secretEncrypted: encrypt(`whsec_dev_${random.hex(32)}`),
      disabledAt: spec.broken ? new Date(now - spec.broken.disabledAgo) : null,
      lastSuccessAt: null,
      lastFailureAt: null,
      createdAt: new Date(now - spec.createdAgo),
    };
    plan.endpoints.push(endpoint);

    const since = spec.broken ? now - spec.broken.disabledAgo - 2 * DAY : now - 3 * DAY;
    const until = spec.broken ? now - spec.broken.disabledAgo : now;
    const sources: { at: number; type: WebhookEventType; payload: Record<string, unknown>; messageId: string | null }[] = [];

    if (spec.key) {
      for (const event of events) {
        const type = event.status ? STATUS_EVENT[event.status] : undefined;
        if (!type || !spec.events.includes(type)) continue;
        const at = event.occurredAt.getTime();
        if (at < since || at >= until) continue;
        const message = messagesById.get(event.messageId);
        if (!message || message.apiKeyId !== spec.key.id) continue;
        sources.push({ at, type, messageId: message.id, payload: { id: event.id, type, created_at: event.occurredAt.toISOString(), data: serializeMessage(message) } });
      }
    }
    if (spec.domain) {
      for (const row of inbound) {
        if (row.domainId !== spec.domain.id || row.receivedAt.getTime() < since) continue;
        sources.push({
          at: row.receivedAt.getTime(),
          type: "inbound.received",
          messageId: null,
          payload: { id: newId("event"), type: "inbound.received", created_at: row.receivedAt.toISOString(), data: serializeInboundMessage(row, { text: row.text, html: row.html }) },
        });
      }
    }

    for (const source of sources) {
      const created = source.at + random.int(100, 1500);
      const deliveryId = newId("webhookDelivery");
      const outcomes: { status: number | null; error: string | null }[] = [];
      if (spec.broken) {
        const tries = random.int(6, 9);
        for (let i = 0; i < tries; i += 1) outcomes.push({ status: spec.broken.status, error: spec.broken.error });
      } else if (random.chance(0.04)) {
        outcomes.push(random.chance(0.5) ? { status: 502, error: "502 Bad Gateway" } : { status: null, error: "Request timed out after 10s" });
        outcomes.push({ status: 200, error: null });
      } else {
        outcomes.push({ status: 200, error: null });
      }

      let at = created + random.int(80, 900);
      const expiresAt = created + DAY;
      outcomes.forEach((outcome, index) => {
        if (index > 0) at += Math.min(2 ** index * MINUTE, 4 * HOUR);
        plan.attempts.push({
          id: newId("webhookAttempt"),
          organizationId,
          deliveryId,
          attempt: index + 1,
          statusCode: outcome.status,
          error: outcome.error,
          durationMs: outcome.status === null ? 10_000 : random.int(60, 450),
          createdAt: new Date(Math.min(at, now)),
        });
      });
      const last = outcomes[outcomes.length - 1]!;
      const succeeded = last.status !== null && last.status < 300;
      if (succeeded) endpoint.lastSuccessAt = new Date(Math.max(endpoint.lastSuccessAt?.getTime() ?? 0, at));
      else endpoint.lastFailureAt = new Date(Math.max(endpoint.lastFailureAt?.getTime() ?? 0, at));
      plan.deliveries.push({
        id: deliveryId,
        organizationId,
        endpointId: endpoint.id,
        messageId: source.messageId,
        eventType: source.type,
        payload: source.payload,
        status: succeeded ? "succeeded" : "exhausted",
        attempts: outcomes.length,
        nextAttemptAt: new Date(at),
        lockedAt: null,
        lockedBy: null,
        expiresAt: new Date(expiresAt),
        lastStatusCode: last.status,
        lastError: last.error,
        succeededAt: succeeded ? new Date(at) : null,
        createdAt: new Date(created),
      });
      if (succeeded && source.messageId) {
        plan.events.push({
          id: newId("event"),
          organizationId,
          messageId: source.messageId,
          kind: "webhook_delivered",
          status: null,
          reason: null,
          bounceType: null,
          providerId: null,
          providerEventId: null,
          detail: { eventType: source.type, url: spec.url, statusCode: 200 },
          occurredAt: new Date(at),
          createdAt: new Date(at),
        });
      }
    }
  }

  // The newest inbound delivery still waiting on a retry.
  const pendingInbound = [...plan.deliveries].reverse().find((d) => d.eventType === "inbound.received" && d.succeededAt !== null);
  if (pendingInbound) {
    pendingInbound.status = "failed";
    pendingInbound.succeededAt = null;
    pendingInbound.lastStatusCode = 500;
    pendingInbound.lastError = "500 Internal Server Error";
    pendingInbound.nextAttemptAt = new Date(now + 4 * MINUTE);
    const attempt = plan.attempts.find((a) => a.deliveryId === pendingInbound.id);
    if (attempt) {
      attempt.statusCode = 500;
      attempt.error = "500 Internal Server Error";
    }
  }

  return plan;
}

export type { EndpointSpec };

/* -------------------------------------------------------------- activity --- */

export type ActivityInsert = typeof activity.$inferInsert;

/** Ids with a hyphen, which `newId` never makes, so a reset can find exactly these rows. */
export const SEEDED_ACTIVITY_PREFIX = "act_dev-";

export class ActivityLog {
  readonly rows: ActivityInsert[] = [];
  private readonly random: Random;
  private readonly organizationId: string;

  constructor(random: Random, organizationId: string) {
    this.random = random;
    this.organizationId = organizationId;
  }

  add(at: number, action: string, actor: ActivityActor, subject: { id?: string | null; label?: string | null } = {}, metadata?: Record<string, unknown>): void {
    this.rows.push({
      id: `${SEEDED_ACTIVITY_PREFIX}${this.random.hex(20)}`,
      organizationId: this.organizationId,
      action,
      family: familyFor(action),
      outcome: outcomeFor(action),
      actorType: actor.type,
      actorId: actor.id,
      actorLabel: actor.label,
      appliesTo: subject.id ?? null,
      subjectLabel: subject.label ?? null,
      metadata: metadata ?? null,
      createdAt: new Date(at),
    });
  }
}
