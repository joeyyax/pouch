import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { fetchWithTimeout } from "@/lib/fetch-timeout";
import { txtText } from "@/lib/dns-providers/txt";
import type {
  Adapter,
  AdapterCapabilities,
  AdapterFactory,
  AdapterHealth,
  AdapterModule,
  CreatedDomain,
  NormalizedEvent,
  NormalizedInboundMessage,
  OutboundMessage,
  ProposedDnsRecord,
  Receipt,
  SignedRequest,
  VerificationStatus,
} from "./types";

const log = logger.child("provider:cloudflare");

const API_BASE = process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4";

// Email Service's own limits: 50 recipients across to/cc/bcc, 5 MiB total message size
// including headers and base64 attachment overhead. The decoded ceiling leaves room for both.
const capabilities: AdapterCapabilities = {
  customHeaders: true,
  maxAttachmentBytes: 3 * 1024 * 1024,
  maxRecipients: 50,
  bulk: false,
  domainsViaApi: true,
  dnsRecordsViaApi: true,
  // A domain-scoped Queue event subscription and its consumer Worker are dashboard/wrangler
  // work; nothing in the account-scoped REST API creates either.
  webhooksViaApi: false,
  removalViaApi: true,
  // Cloudflare has no ownership marker on a sending domain, so nothing marks one as ours.
  adoptionViaApi: false,
  // One API token and account id send for every domain onboarded onto the account.
  credentialsWithoutConsole: true,
  // Cloudflare Email Routing receives mail (developers.cloudflare.com/email-service/get-started/
  // route-emails) and forwards it to a Worker's email() handler — the same Worker-forwarding
  // shape this adapter already uses for outbound delivery events.
  sharing: false,
  // Unconfirmed: a sending domain is onboarded per name, and nothing documents subdomains inheriting it.
  subdomainSending: false,
};

/** Cloudflare's code for a sending domain this account already onboarded. */
const SUBDOMAIN_EXISTS = 2040;

const credentialsSchema = z.object({
  apiToken: z.string().min(1).describe("Cloudflare API token scoped to Email Sending: Edit, Account Settings: Read and Zone: Read."),
  accountId: z.string().min(1).describe("Cloudflare account id the sending domains belong to."),
});

const settingsSchema = z.object({
  webhookPublicKey: z
    .string()
    .min(1)
    .optional()
    .describe("Ed25519 public key for the Queue consumer Worker's signature, base64 or PEM. Events don't verify without it."),
});

interface CloudflareCredentials {
  apiToken: string;
  accountId: string;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CfError {
  code: number;
  message: string;
}

interface CfEnvelope<T> {
  success: boolean;
  errors: CfError[];
  result: T | null;
}

/** DER header for an Ed25519 SPKI key, so a raw 32-byte key can be read by node:crypto. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const SIGNATURE_HEADER = "x-cloudflare-worker-signature";
const SIGNATURE_BYTES = 64;

/** Reads a header whatever case the sender used. */
function header(headers: Record<string, string>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

/** The Worker shows the key as raw base64. A pasted PEM works too. */
function readPublicKey(value: string, accountId: string): KeyObject | null {
  try {
    if (value.includes("BEGIN PUBLIC KEY")) return createPublicKey(value);
    const raw = Buffer.from(value, "base64");
    if (raw.length !== 32) {
      log.warn(`account ${accountId} has a webhook public key that decoded to ${raw.length} bytes, not 32; events will fail to verify`);
      return null;
    }
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
  } catch {
    log.warn(`account ${accountId} has a webhook public key that failed to parse; events will fail to verify`);
    return null;
  }
}

interface CfDnsRecord {
  type?: string;
  name?: string;
  content?: string;
  priority?: number;
}

const DNS_TYPES = new Set(["TXT", "CNAME", "MX"]);

/**
 * Cloudflare only onboards a domain whose zone it already hosts, so it writes these records into
 * its own DNS itself rather than asking the caller to publish them. They're proposed here anyway
 * so the domains layer can display what was created and re-check it if the zone ever drifts.
 */
function recordsFrom(records: CfDnsRecord[]): ProposedDnsRecord[] {
  return records
    .filter((record): record is CfDnsRecord & { type: string; name: string; content: string } =>
      Boolean(record.type && DNS_TYPES.has(record.type) && record.name && record.content),
    )
    .map((record) => ({
      type: record.type as ProposedDnsRecord["type"],
      name: record.name,
      value: record.type === "TXT" ? txtText(record.content) : record.content,
      required: true,
      ...(record.type === "MX" && typeof record.priority === "number" ? { priority: record.priority } : {}),
    }));
}

/**
 * Ed25519 over the raw body, checked against whichever public key applies — the account's for
 * outbound delivery events, a domain's own for inbound. `label` is only for the log line.
 */
function verifyEd25519(rawBody: string, headers: Record<string, string>, publicKey: string | undefined, label: string): boolean {
  const key = publicKey ? readPublicKey(publicKey, label) : null;
  if (!key) return false;

  const provided = header(headers, SIGNATURE_HEADER);
  if (!provided) return false;
  const signature = Buffer.from(provided, "base64");
  if (signature.length !== SIGNATURE_BYTES) return false;

  try {
    return verifySignature(null, Buffer.from(rawBody, "utf8"), key, signature);
  } catch {
    return false;
  }
}

// Cloudflare's DNS API is the slowest thing this adapter calls; anything past this is a hang,
// not a slow zone.
const API_TIMEOUT_MS = 30_000;

const create: AdapterFactory = (credentials, settings, accountId): Adapter => {
  const { apiToken, accountId: cfAccountId } = credentials as unknown as CloudflareCredentials;
  const webhookPublicKey = settings.webhookPublicKey;

  async function call<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: CfEnvelope<T> | null }> {
    const { response, text } = await fetchWithTimeout(
      `${API_BASE}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
      },
      API_TIMEOUT_MS,
      `Cloudflare ${path}`,
    );
    let body: CfEnvelope<T> | null = null;
    try {
      body = JSON.parse(text) as CfEnvelope<T>;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  function errorsOf(body: CfEnvelope<unknown> | null, status: number): string[] {
    const messages = body?.errors?.map((error) => error.message) ?? [];
    return messages.length > 0 ? messages : [`HTTP ${status}`];
  }

  /**
   * Email Sending is zone-scoped, so a domain (or a subdomain of one) has to resolve to the
   * Cloudflare zone hosting it before its sending subdomain can be created. Tried from the most
   * specific candidate down, since the zone is the registrable domain, not necessarily `name`
   * itself.
   */
  async function findZoneId(name: string): Promise<string | null> {
    const labels = name.split(".");
    for (let start = 0; start < labels.length - 1; start++) {
      const candidate = labels.slice(start).join(".");
      const { body } = await call<{ id: string }[]>(`/zones?name=${encodeURIComponent(candidate)}&per_page=1`);
      const zone = body?.result?.[0];
      if (zone) return zone.id;
    }
    return null;
  }

  async function send(message: OutboundMessage): Promise<Receipt> {
    // Cloudflare sets its own Feedback-ID and refuses a send that carries one.
    const headers = Object.fromEntries(Object.entries(message.headers).filter(([name]) => name.toLowerCase() !== "feedback-id"));
    const payload: Record<string, unknown> = {
      to: message.to,
      cc: message.cc.length > 0 ? message.cc : undefined,
      bcc: message.bcc.length > 0 ? message.bcc : undefined,
      reply_to: message.replyTo.length > 0 ? message.replyTo : undefined,
      from: { address: message.from.address, name: message.from.name ?? undefined },
      subject: message.subject,
      html: message.html ?? undefined,
      text: message.text ?? undefined,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      attachments:
        message.attachments.length > 0
          ? message.attachments.map((attachment) => ({
              content: attachment.content,
              filename: attachment.filename,
              type: attachment.contentType,
              disposition: "attachment",
            }))
          : undefined,
    };

    let status: number;
    let body: CfEnvelope<{ message_id?: string }> | null;
    try {
      ({ status, body } = await call<{ message_id?: string }>(`/accounts/${cfAccountId}/email/sending/send`, {
        method: "POST",
        body: JSON.stringify(payload),
      }));
    } catch (err) {
      return { successful: false, errors: [reasonOf(err)], failure: "transient" };
    }

    if (body?.success && body.result) {
      if (!body.result.message_id) {
        return { successful: false, errors: ["Provider accepted the message without an id."], failure: "transient" };
      }
      return { successful: true, providerMessageId: body.result.message_id };
    }

    const errors = errorsOf(body, status);
    const codes = new Set(body?.errors?.map((error) => error.code) ?? []);

    if (status === 429 || codes.has(10004)) {
      return { successful: false, errors, failure: "backoff", retryAfterSeconds: 60 };
    }
    // Account or zone-wide sending disabled, or the account isn't entitled to Email Sending at
    // all — neither clears by retrying this one message, only by pausing the account.
    if (codes.has(10203) || codes.has(10105)) {
      return { successful: false, errors, failure: "backoff", retryAfterSeconds: 15 * 60 };
    }
    if (status >= 500 || status === 0) {
      return { successful: false, errors, failure: "transient" };
    }
    return { successful: false, errors, failure: "permanent" };
  }

  /**
   * Account Details is metadata-only — no send, no domain change — so it proves the token and
   * account id are valid without costing anything close to a send.
   */
  async function healthCheck(): Promise<AdapterHealth> {
    try {
      const { status, body } = await call<{ id: string }>(`/accounts/${cfAccountId}`);
      if (status === 401 || status === 403) return { ok: false, detail: "Credentials were rejected." };
      if (status === 429) return { ok: false, detail: "Rate limited by the provider." };
      if (!body?.success) return { ok: false, detail: "Provider unreachable or returned an error." };
      return { ok: true, detail: null };
    } catch {
      return { ok: false, detail: "Provider unreachable or returned an error." };
    }
  }

  /**
   * The Cloudflare account id these credentials send through. Reported straight from the account
   * details call rather than trusted from input, so a token that can't actually reach that
   * account never gets to claim it.
   */
  async function identity(): Promise<string | null> {
    try {
      const { body } = await call<{ id: string }>(`/accounts/${cfAccountId}`);
      return body?.success && body.result?.id ? body.result.id : null;
    } catch (err) {
      log.warn(`fetching the account identity failed: ${reasonOf(err)}`);
      return null;
    }
  }

  return {
    adapter: "cloudflare",
    capabilities,
    send,
    canHealthCheck: true,
    healthCheck,
    identity,

    domain: {
      async create(name: string): Promise<CreatedDomain> {
        const zoneId = await findZoneId(name);
        if (!zoneId) {
          throw new Error(`No Cloudflare zone hosts ${name}. Email Sending only onboards domains on Cloudflare's own DNS.`);
        }

        const created = await call<{ tag: string }>(`/zones/${zoneId}/email/sending/subdomains`, {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        let tag = created.body?.success ? created.body.result?.tag : undefined;
        // Already onboarded on this account, from the dashboard or an earlier add: use it.
        if (!tag && created.body?.errors?.some((error) => error.code === SUBDOMAIN_EXISTS)) {
          const existing = await call<{ tag: string; name: string }[]>(`/zones/${zoneId}/email/sending/subdomains`);
          tag = existing.body?.result?.find((subdomain) => subdomain.name === name)?.tag;
        }
        if (!tag) throw new Error(`${errorsOf(created.body, created.status).join("; ")}.`);

        const dns = await call<CfDnsRecord[]>(`/zones/${zoneId}/email/sending/subdomains/${tag}/dns`);
        return {
          providerDomainId: `${zoneId}:${tag}`,
          records: recordsFrom(dns.body?.result ?? []),
        };
      },

      async verify(name: string, providerDomainId: string | null): Promise<VerificationStatus> {
        if (!providerDomainId) {
          return { answered: false, verified: false, missing: [], errors: ["Domain has no provider id. Create it first."] };
        }
        const [zoneId, tag] = providerDomainId.split(":");
        if (!zoneId || !tag) {
          return { answered: false, verified: false, missing: [], errors: ["Domain's provider id is malformed."] };
        }

        let subdomain: { status: number; body: CfEnvelope<{ enabled: boolean }> | null };
        let dns: { status: number; body: CfEnvelope<CfDnsRecord[]> | null };
        try {
          [subdomain, dns] = await Promise.all([
            call<{ enabled: boolean }>(`/zones/${zoneId}/email/sending/subdomains/${tag}`),
            call<CfDnsRecord[]>(`/zones/${zoneId}/email/sending/subdomains/${tag}/dns`),
          ]);
        } catch (err) {
          return { answered: false, verified: false, missing: [], errors: [reasonOf(err)] };
        }

        if (!subdomain.body?.success || !subdomain.body.result) {
          return { answered: false, verified: false, missing: [], errors: errorsOf(subdomain.body, subdomain.status) };
        }

        // Cloudflare exposes no DNS-propagation status distinct from `enabled` — unlike SES, it's
        // the zone's own DNS host, so there's no external record it can be waiting to see.
        // `enabled` is the one readiness signal the API gives, and it's honestly reported as such.
        const verified = subdomain.body.result.enabled === true;
        return {
          answered: true,
          verified,
          missing: verified ? [] : recordsFrom(dns.body?.result ?? []),
          errors: [],
        };
      },

      async remove(_name: string, providerDomainId: string | null): Promise<void> {
        if (!providerDomainId) return;
        const [zoneId, tag] = providerDomainId.split(":");
        if (!zoneId || !tag) return;
        const { status, body } = await call(`/zones/${zoneId}/email/sending/subdomains/${tag}`, { method: "DELETE" });
        if (status === 404 || (status < 300 && body?.success !== false)) return;
        throw new Error(errorsOf(body, status).join("; "));
      },
    },

    events: {
      /** Ed25519 over the raw body, against the webhook key the Queue consumer Worker signs with. */
      async verify(request: SignedRequest): Promise<boolean> {
        return verifyEd25519(request.rawBody, request.headers, webhookPublicKey, accountId);
      },

      parse(request: SignedRequest): NormalizedEvent[] {
        let body: CloudflareForwardedEvent;
        try {
          body = JSON.parse(request.rawBody) as CloudflareForwardedEvent;
        } catch {
          log.warn(`account ${accountId} sent a signed webhook body that isn't valid JSON`);
          return [];
        }

        const status = EVENT_STATUS[body.type ?? ""];
        const messageId = body.payload?.messageId;
        if (!status || !messageId) return [];

        return [
          {
            providerMessageId: messageId,
            providerEventId: body.eventId ?? null,
            status,
            reason: body.payload?.delivery?.smtpStatusCode ?? null,
            occurredAt: eventTime(body.metadata?.eventTimestamp),
            detail: body as unknown as Record<string, unknown>,
            recipients: body.payload?.recipient ? [body.payload.recipient] : [],
          },
        ];
      },
    },

    inbound: {
      // Cloudflare Email Routing wants three MX records plus an SPF TXT
      // (developers.cloudflare.com/email-service/get-started/route-emails). Its guided setup
      // targets the zone apex; pointing them at the inbound subdomain instead, and matching a
      // routing rule to it, is a manual step the same way the consumer Worker itself is — see
      // stepsFor in lib/providers/adapters/setup.ts.
      records(name: string): ProposedDnsRecord[] {
        return [
          { type: "MX", name, value: "route1.mx.cloudflare.net", priority: 10, required: false },
          { type: "MX", name, value: "route2.mx.cloudflare.net", priority: 20, required: false },
          { type: "MX", name, value: "route3.mx.cloudflare.net", priority: 30, required: false },
          { type: "TXT", name, value: "v=spf1 include:_spf.mx.cloudflare.net ~all", required: false },
        ];
      },
      // Same Ed25519 scheme as outbound delivery events, keyed by the domain's own settings —
      // this account's Worker is written to sign inbound forwards with that domain's key.
      verify(request: SignedRequest, domainSettings: Record<string, string>): boolean {
        return verifyEd25519(request.rawBody, request.headers, domainSettings.webhookPublicKey, accountId);
      },
      parse(request: SignedRequest): NormalizedInboundMessage[] {
        let body: CloudflareForwardedInboundMessage;
        try {
          body = JSON.parse(request.rawBody) as CloudflareForwardedInboundMessage;
        } catch {
          log.warn(`account ${accountId} sent a signed inbound webhook body that isn't valid JSON`);
          return [];
        }
        if (!body.from?.address) return [];

        return [
          {
            providerMessageId: body.messageId ?? null,
            from: { name: body.from.name ?? null, address: body.from.address },
            to: body.to ?? [],
            subject: body.subject ?? "",
            text: body.text ?? null,
            html: body.html ?? null,
            headers: body.headers ?? {},
            messageId: body.headers?.["message-id"] ?? null,
            inReplyTo: body.headers?.["in-reply-to"] ?? null,
            attachments: (body.attachments ?? []).flatMap((attachment) =>
              attachment.filename && attachment.contentType && attachment.content
                ? [{ filename: attachment.filename, contentType: attachment.contentType, content: Buffer.from(attachment.content, "base64") }]
                : [],
            ),
            raw: null,
            verdicts: null,
          },
        ];
      },
    },
  };
};

/**
 * The email the consumer Worker forwards after parsing the raw MIME message it received —
 * mirrors CloudflareForwardedEvent below, one normalized JSON body per inbound item.
 */
interface CloudflareForwardedInboundMessage {
  messageId?: string;
  from?: { name?: string; address: string };
  to?: string[];
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: { filename?: string; contentType?: string; content?: string }[];
}

/** The event the Queue consumer Worker forwards: a Cloudflare Email Sending event plus the id its own Queue message carried. */
interface CloudflareForwardedEvent {
  type?: string;
  eventId?: string;
  metadata?: { eventTimestamp?: string };
  payload?: {
    messageId?: string;
    recipient?: string;
    delivery?: { status?: string; smtpStatusCode?: string };
  };
}

/** Cloudflare's own event time, or the arrival time when it's missing or unreadable. */
function eventTime(stamp: string | undefined): Date {
  const at = stamp ? new Date(stamp) : null;
  return at && !Number.isNaN(at.getTime()) ? at : new Date();
}

const EVENT_STATUS: Record<string, NormalizedEvent["status"]> = {
  "cf.email.sending.message.delivered": "delivered",
  "cf.email.sending.message.deferred": "deferred",
  "cf.email.sending.message.bounced": "bounced",
  "cf.email.sending.message.failed": "failed",
  "cf.email.sending.message.rejected": "failed",
  "cf.email.sending.message.complained": "complained",
};

export const cloudflare: AdapterModule = {
  adapter: "cloudflare",
  capabilities,
  credentialsSchema,
  settingsSchema,
  create,
};
