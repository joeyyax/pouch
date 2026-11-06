import { X509Certificate, createVerify } from "node:crypto";
import { ConfirmSubscriptionCommand } from "@aws-sdk/client-sns";
import type { Adapter, ControlOutcome, NormalizedEvent, SignedRequest } from "../types";
import { log, type SesContext } from "./client";
import { reasonOf } from "./errors";
import { parseEnvelope, type SnsEnvelope } from "./sns";

/** Canonical field order SNS signs, per message type. */
const SIGNED_FIELDS: Record<string, string[]> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
  UnsubscribeConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
};

/** Signing certificates change rarely, and every event would otherwise fetch one. */
const certificates = new Map<string, string>();

/** SNS uses a handful of signing certificates; anything past this is someone filling memory. */
export const MAX_CACHED_CERTIFICATES = 16;

/** A certificate fetch happens inside a webhook request, so it can't be allowed to hang. */
export const CERTIFICATE_TIMEOUT_MS = 5_000;

/** Clears the signing certificate cache. Tests only. */
export function resetCertificateCache(): void {
  certificates.clear();
}

/** How many certificates are cached. Tests only. */
export function cachedCertificateCount(): number {
  return certificates.size;
}

export function createEvents(context: SesContext): Adapter["events"] {
  const { region, topicArn, snsClient } = context;

  /** SNS serves signing certificates from its own regional host, over https, and nowhere else. */
  function certificateUrlAllowed(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && parsed.host === `sns.${region}.amazonaws.com`;
    } catch {
      return false;
    }
  }

  async function signingCertificate(url: string): Promise<string | null> {
    const cached = certificates.get(url);
    if (cached) return cached;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Fetching the signing certificate timed out after ${CERTIFICATE_TIMEOUT_MS}ms.`)),
      CERTIFICATE_TIMEOUT_MS,
    );
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      const pem = await response.text();
      // Oldest out first, so a stream of new URLs can't grow the map without bound.
      if (certificates.size >= MAX_CACHED_CERTIFICATES) {
        const oldest = certificates.keys().next().value;
        if (oldest !== undefined) certificates.delete(oldest);
      }
      certificates.set(url, pem);
      return pem;
    } catch (err) {
      log.warn(`fetching the SNS signing certificate failed: ${reasonOf(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function canonicalString(envelope: SnsEnvelope): string | null {
    const fields = SIGNED_FIELDS[envelope.Type];
    if (!fields) return null;
    return fields
      .filter((field) => envelope[field] !== undefined)
      .map((field) => `${field}\n${envelope[field]}\n`)
      .join("");
  }

  async function verifyEnvelope(envelope: SnsEnvelope): Promise<boolean> {
    if (!envelope.Signature || !envelope.SigningCertURL) return false;
    // The 401 decision belongs here, so a genuinely SNS-signed message from someone else's
    // topic is rejected at the gate rather than dropped later by parse.
    if (!topicArn || envelope.TopicArn !== topicArn) {
      log.warn(`refusing an event on ${envelope.TopicArn}`);
      return false;
    }
    if (!certificateUrlAllowed(envelope.SigningCertURL)) {
      log.warn(`refusing a signing certificate from ${envelope.SigningCertURL}`);
      return false;
    }

    const canonical = canonicalString(envelope);
    if (canonical === null) return false;

    const pem = await signingCertificate(envelope.SigningCertURL);
    if (!pem) return false;

    // SignatureVersion 1 is SHA1. The topic is configured for 2 (SHA256) only, and SHA1 stays
    // refused even if SNS ever sends it — this route takes unauthenticated internet traffic.
    if (envelope.SignatureVersion !== "2") {
      log.warn(`refusing SignatureVersion ${envelope.SignatureVersion}`);
      return false;
    }
    const algorithm = "RSA-SHA256";

    try {
      const publicKey = new X509Certificate(pem.trim()).publicKey;
      return createVerify(algorithm).update(canonical, "utf8").verify(publicKey, Buffer.from(envelope.Signature, "base64"));
    } catch (err) {
      log.warn(`SNS signature check threw: ${reasonOf(err)}`);
      return false;
    }
  }

  return {
    async verify(request: SignedRequest): Promise<boolean> {
      const envelope = parseEnvelope(request.rawBody);
      if (!envelope) return false;
      return verifyEnvelope(envelope);
    },

    /** SNS asks the endpoint to confirm a subscription before it sends any events. */
    async control(request: SignedRequest): Promise<ControlOutcome> {
      const envelope = parseEnvelope(request.rawBody);
      if (!envelope || envelope.Type !== "SubscriptionConfirmation") return { handled: false, action: null };

      if (!topicArn || envelope.TopicArn !== topicArn) {
        log.warn(`refusing to confirm a subscription to ${envelope.TopicArn}`);
        return { handled: true, action: "ignored_unknown_topic" };
      }

      await snsClient.send(new ConfirmSubscriptionCommand({ TopicArn: envelope.TopicArn, Token: envelope.Token }));
      return { handled: true, action: "subscription_confirmed", settings: { subscriptionConfirmed: "true" } };
    },

    parse(request: SignedRequest): NormalizedEvent[] {
      const envelope = parseEnvelope(request.rawBody);
      if (!envelope || envelope.Type !== "Notification") return [];
      if (!topicArn || envelope.TopicArn !== topicArn) {
        log.warn(`ignoring a notification on ${envelope.TopicArn}`);
        return [];
      }

      let payload: SesEventPayload;
      try {
        payload = JSON.parse(envelope.Message) as SesEventPayload;
      } catch {
        return [];
      }

      const mapped = mapEvent(payload);
      if (!mapped) return [];

      return [
        {
          providerMessageId: payload.mail?.messageId ?? "",
          providerEventId: envelope.MessageId,
          status: mapped.status,
          reason: mapped.reason,
          bounceType: mapped.bounceType,
          occurredAt: new Date(mapped.occurredAt ?? payload.mail?.timestamp ?? envelope.Timestamp ?? Date.now()),
          detail: payload as unknown as Record<string, unknown>,
          recipients: mapped.recipients,
        },
      ];
    },
  };
}

interface SesRecipient {
  emailAddress?: string;
  diagnosticCode?: string;
}

interface SesEventPayload {
  eventType?: string;
  mail?: { messageId?: string; timestamp?: string; destination?: string[] };
  bounce?: { bounceType?: string; bounceSubType?: string; bouncedRecipients?: SesRecipient[]; timestamp?: string };
  complaint?: { complainedRecipients?: SesRecipient[]; complaintFeedbackType?: string; timestamp?: string };
  delivery?: { timestamp?: string; recipients?: string[] };
  deliveryDelay?: { delayType?: string; timestamp?: string; delayedRecipients?: SesRecipient[] };
  reject?: { reason?: string };
}

interface MappedEvent {
  status: NormalizedEvent["status"];
  reason: string | null;
  bounceType?: string | null;
  recipients: string[];
  /** When the event happened. SES puts the send time on mail.timestamp for every event type. */
  occurredAt: string | null;
}

/**
 * The addresses SES actually named. Empty when it didn't — falling back to the message's whole
 * destination would blame every recipient for one, so bounce, complaint and deferral events
 * with nothing named come back with nothing named.
 */
function addressesOf(recipients: SesRecipient[] | undefined): string[] {
  return (recipients ?? []).map((recipient) => recipient.emailAddress).filter((one): one is string => Boolean(one));
}

/** Maps an SES event to a lifecycle status. Anything unmapped, opens and clicks included, is dropped. */
function mapEvent(payload: SesEventPayload): MappedEvent | null {
  const destination = payload.mail?.destination ?? [];

  switch (payload.eventType) {
    case "Send":
      return { status: "sent", reason: null, recipients: destination, occurredAt: payload.mail?.timestamp ?? null };
    case "Delivery":
      // delivery.recipients names who this notification is about, distinct from mail.destination
      // (everyone on the send) — SES sends one Delivery notification per recipient.
      return {
        status: "delivered",
        reason: null,
        recipients: payload.delivery?.recipients ?? [],
        occurredAt: payload.delivery?.timestamp ?? null,
      };
    case "DeliveryDelay":
      return {
        status: "deferred",
        reason: payload.deliveryDelay?.delayType ?? null,
        recipients: addressesOf(payload.deliveryDelay?.delayedRecipients),
        occurredAt: payload.deliveryDelay?.timestamp ?? null,
      };
    case "Bounce": {
      const recipients = payload.bounce?.bouncedRecipients;
      const bounceType = [payload.bounce?.bounceType, payload.bounce?.bounceSubType].filter(Boolean).join("/") || null;
      // Only a permanent bounce is a bounce. A transient one is the provider still trying.
      return {
        status: payload.bounce?.bounceType === "Permanent" ? "bounced" : "deferred",
        reason: recipients?.[0]?.diagnosticCode || bounceType,
        bounceType,
        recipients: addressesOf(recipients),
        occurredAt: payload.bounce?.timestamp ?? null,
      };
    }
    case "Complaint":
      return {
        status: "complained",
        reason: payload.complaint?.complaintFeedbackType ?? null,
        recipients: addressesOf(payload.complaint?.complainedRecipients),
        occurredAt: payload.complaint?.timestamp ?? null,
      };
    case "Reject":
      return {
        status: "failed",
        reason: payload.reject?.reason ?? null,
        recipients: destination,
        occurredAt: payload.mail?.timestamp ?? null,
      };
    default:
      return null;
  }
}
