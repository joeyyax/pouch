/** Programmable addresses in every state the dashboard shows, with their mail and forward targets. */
import type { addressForwardTargets, addresses, InboundMessageRow } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { DAY, HOUR, MINUTE, type History, type KeyRef, type Sender } from "./history";
import type { Random } from "./random";

export interface AddressPlan {
  addresses: (typeof addresses.$inferInsert)[];
  targets: (typeof addressForwardTargets.$inferInsert)[];
  inbound: InboundMessageRow[];
  /** Screenshot landmarks, by the state each address stands for. */
  landmarks: Record<string, string>;
}

interface AddressSeed {
  landmark: string;
  localPart: string;
  label: string | null;
  createdAgo: number;
  /** Positive is ahead of now. */
  expiresIn: number;
  cap?: number;
  received: number;
  today?: number;
  droppedExpired?: number;
  droppedOverLimit?: number;
  droppedVirus?: number;
  forwarded?: number;
  revokedAgo?: number;
  /** Stored messages, newest first. */
  mail: { subject: string; from: string; ago: number; spam?: boolean }[];
}

const SEEDS: AddressSeed[] = [
  {
    landmark: "addressActive",
    localPart: "signup-a7k2",
    label: "Acme trial signup",
    createdAgo: 1 * DAY,
    expiresIn: 2 * DAY,
    received: 3,
    today: 1,
    mail: [
      { subject: "Your Acme verification code is 482913", from: "no-reply@acme-trials.example.com", ago: 40 * MINUTE },
      { subject: "Welcome to your Acme trial", from: "hello@acme-trials.example.com", ago: 20 * HOUR },
      { subject: "Confirm your email for Acme", from: "no-reply@acme-trials.example.com", ago: 23 * HOUR },
    ],
  },
  {
    landmark: "addressNearCap",
    localPart: "qa-otp-runner",
    label: "Login codes for the QA suite",
    createdAgo: 9 * DAY,
    expiresIn: 5 * HOUR,
    cap: 50,
    received: 48,
    today: 6,
    mail: Array.from({ length: 8 }, (_, i) => ({ subject: `Your sign-in code is ${310_204 + i * 7_919}`, from: "auth@scope.example", ago: (i * 55 + 12) * MINUTE })),
  },
  {
    landmark: "addressSoon",
    localPart: "magic-link-e2e",
    label: "Magic link e2e run 4821",
    createdAgo: 25 * MINUTE,
    expiresIn: 35 * MINUTE,
    received: 1,
    today: 1,
    mail: [{ subject: "Your sign-in link for Scope", from: "auth@scope.example", ago: 22 * MINUTE }],
  },
  {
    landmark: "addressForward",
    localPart: "support-handoff",
    label: "Support handoff for ticket 1182",
    createdAgo: 6 * DAY,
    expiresIn: 20 * DAY,
    received: 5,
    forwarded: 4,
    droppedVirus: 1,
    mail: [
      { subject: "Re: Invoice 2219 is wrong", from: "maria.ortega@example.net", ago: 3 * HOUR },
      { subject: "Limited offer: rank first on Google", from: "seo-team@example.org", ago: 9 * HOUR, spam: true },
      { subject: "Re: Invoice 2219 is wrong", from: "maria.ortega@example.net", ago: 2 * DAY },
      { subject: "Invoice 2219 is wrong", from: "maria.ortega@example.net", ago: 5 * DAY },
      { subject: "Can someone call me back?", from: "maria.ortega@example.net", ago: 6 * DAY - HOUR },
    ],
  },
  {
    landmark: "addressExpired",
    localPart: "beta-invite-wave2",
    label: "Beta invites, wave 2",
    createdAgo: 17 * DAY,
    expiresIn: -3 * DAY,
    received: 12,
    droppedExpired: 4,
    mail: [
      { subject: "Your beta invite is ready", from: "invites@fieldnotes.app", ago: 4 * DAY },
      { subject: "Your beta invite is ready", from: "invites@fieldnotes.app", ago: 6 * DAY },
    ],
  },
  {
    landmark: "addressRevoked",
    localPart: "partner-test",
    label: null,
    createdAgo: 40 * DAY,
    expiresIn: 50 * DAY,
    received: 2,
    droppedExpired: 1,
    revokedAgo: 10 * DAY,
    mail: [{ subject: "Partner API sandbox credentials", from: "partners@harborline.co", ago: 12 * DAY }],
  },
  {
    landmark: "addressLong",
    localPart: "order-confirmations-staging-environment-eu-west-customer-48213x",
    label: "Order confirmation tests for the EU staging environment, customer 48213, run by the nightly checkout suite",
    createdAgo: 2 * DAY,
    expiresIn: 30 * DAY,
    cap: 1000,
    received: 0,
    mail: [],
  },
];

export function planAddresses(history: History, random: Random, organizationId: string, spec: { domain: Sender; host: string; key: KeyRef }): AddressPlan {
  const now = history.now;
  const today = new Date(now).toISOString().slice(0, 10);
  const plan: AddressPlan = { addresses: [], targets: [], inbound: [], landmarks: {} };

  for (const seed of SEEDS) {
    const id = newId("address");
    const address = `${seed.localPart}@${spec.host}`;
    const newest = seed.mail[0];
    plan.landmarks[seed.landmark] = id;
    plan.addresses.push({
      id,
      organizationId,
      domainId: spec.domain.id,
      apiKeyId: spec.key.id,
      localPart: seed.localPart,
      label: seed.label,
      status: seed.revokedAgo !== undefined ? "revoked" : seed.expiresIn < 0 ? "expired" : "active",
      expiresAt: new Date(now + seed.expiresIn),
      messageCap: seed.cap ?? null,
      receivedCount: seed.received,
      droppedExpiredCount: seed.droppedExpired ?? 0,
      droppedOverLimitCount: seed.droppedOverLimit ?? 0,
      droppedVirusCount: seed.droppedVirus ?? 0,
      forwardedCount: seed.forwarded ?? 0,
      receivedToday: seed.today ?? 0,
      receivedDay: seed.today ? today : null,
      lastReceivedAt: newest ? new Date(now - newest.ago) : null,
      revokedAt: seed.revokedAgo !== undefined ? new Date(now - seed.revokedAgo) : null,
      createdAt: new Date(now - seed.createdAgo),
      updatedAt: new Date(now - (seed.revokedAgo ?? seed.createdAgo)),
    });

    for (const mail of seed.mail) {
      const receivedAt = now - mail.ago;
      const messageId = `<${random.hex(24)}@${mail.from.split("@")[1]}>`;
      const text = mail.spam ? "Dear Sir/Madam, we can get your site to the first page of Google in 30 days." : `${mail.subject}.\n\nSent to ${address}.`;
      plan.inbound.push({
        id: newId("inbound"),
        organizationId,
        domainId: spec.domain.id,
        providerMessageId: random.hex(32),
        fromAddress: mail.from,
        fromName: null,
        to: [address],
        subject: mail.subject,
        text,
        html: `<p>${text.replace(/\n/g, "<br>")}</p>`,
        // Sealed after insert by sealLegacyInbound, as planInbound's rows are.
        bodyKey: null,
        storageKey: null,
        headers: { "Message-Id": messageId, Subject: mail.subject },
        messageId,
        inReplyTo: null,
        outboundMessageId: null,
        attachments: [],
        rawStorageKey: null,
        addressIds: [id],
        threadId: newId("thread"),
        verdicts: { spam: mail.spam ? "FAIL" : "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" },
        receivedAt: new Date(receivedAt),
        expiresAt: new Date(receivedAt + 30 * DAY),
        createdAt: new Date(receivedAt + random.int(200, 3000)),
      });
    }

    if (seed.landmark !== "addressForward") continue;
    const added = now - 6 * DAY + HOUR;
    const target = (email: string, values: Partial<typeof addressForwardTargets.$inferInsert>) =>
      plan.targets.push({ id: newId("forwardTarget"), organizationId, addressId: id, email, createdAt: new Date(added), updatedAt: new Date(now - HOUR), ...values });
    target("ops@scope.example", {
      status: "confirmed",
      tokenHash: random.hex(32),
      confirmationSentAt: new Date(added),
      confirmedAt: new Date(added + HOUR),
      forwardedCount: 4,
      lastForwardedAt: new Date(now - 3 * HOUR + MINUTE),
    });
    target("dana.whitfield@example.com", {
      status: "pending",
      tokenHash: random.hex(32),
      tokenExpiresAt: new Date(now - 2 * HOUR + 7 * DAY),
      confirmationSentAt: new Date(now - 2 * HOUR),
      createdAt: new Date(now - 2 * HOUR),
    });
    target("old-inbox@example.net", {
      status: "disabled",
      confirmationSentAt: new Date(added),
      confirmedAt: new Date(added + 2 * HOUR),
      disabledAt: new Date(now - 2 * DAY + 5 * MINUTE),
      disabledReason: "bounced",
      lastForwardedAt: new Date(now - 2 * DAY),
    });
  }
  return plan;
}
