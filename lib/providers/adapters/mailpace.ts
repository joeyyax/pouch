import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { z } from "zod";
import { formatAddress, parseAddress } from "@/lib/addresses";
import { envelopeHints, parseRecipients } from "@/lib/inbound/recipients";
import { logger } from "@/lib/logger";
import type {
  Adapter,
  AdapterCapabilities,
  AdapterFactory,
  AdapterHealth,
  AdapterModule,
  CreatedDomain,
  ProposedDnsRecord,
  NormalizedEvent,
  NormalizedInboundMessage,
  OutboundMessage,
  Receipt,
  SignedRequest,
  VerificationStatus,
} from "./types";
import { DomainApiUnavailableError } from "./types";

const API_BASE = process.env.MAILPACE_API_BASE ?? "https://app.mailpace.com/api/v1";

// A call must finish well inside the worker's lock timeout (5 minutes, lib/messages/queue.ts)
// so a hung request can't outlive the lock. tests/unit/providers.test.ts asserts the margin.
export const SEND_TIMEOUT_MS = 60_000;

// Mailpace's documented limits: 50 recipients per send, no dedicated bulk endpoint. The
// attachment ceiling is kept below Mailpace's 30 MB total-message cap to leave room for
// headers and the rest of the payload.
const capabilities: AdapterCapabilities = {
  customHeaders: false,
  maxAttachmentBytes: 20 * 1024 * 1024,
  maxRecipients: 50,
  bulk: false,
  // Both need an organization token; `capabilitiesWith` drops them without one.
  domainsViaApi: true,
  dnsRecordsViaApi: true,
  // Mailpace registers event webhooks in its dashboard, per domain.
  webhooksViaApi: false,
  // Confirmed against docs.mailpace.com/reference/domains/: the only DELETE there revokes a
  // domain API token, not the domain itself. Nothing removes a domain through the API.
  removalViaApi: false,
  // Mailpace has no tags or ownership on a domain, so nothing marks one as ours.
  adoptionViaApi: false,
  credentialsWithoutConsole: false,
  // Confirmed against Mailpace's current docs (docs.mailpace.com/guide/inbound): inbound is a
  // JSON webhook, signed Ed25519 the same way as delivery events, over the domain's own keypair.
  sharing: false,
  // A send's from "must be the domain associated with this API token" (docs.mailpace.com/reference/send).
  subdomainSending: false,
};

const credentialsSchema = z.object({
  serverToken: z.string().min(1).describe("Per-domain send token from the domain's settings."),
  organizationToken: z
    .string()
    .min(1)
    .optional()
    .describe("Account-wide token, for the domains API and health checks. Created on Mailpace's Organization API Tokens page."),
});

const settingsSchema = z.object({
  webhookPublicKey: z
    .string()
    .min(1)
    .optional()
    .describe("Ed25519 webhook key from the domain's settings, base64 or PEM. Events don't verify without it."),
});

interface MailpaceCredentials {
  /** Per-domain send token. */
  serverToken: string;
  /** Account-wide token for the domains API. */
  organizationToken?: string;
}

interface SendSuccess {
  id: number | string;
  status: string;
}

/** Turns Mailpace's `{errors: {field: [msg]}}` or `{error: msg}` into flat strings. */
function readErrors(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const record = body as Record<string, unknown>;
  if (typeof record.error === "string") return [record.error];
  if (typeof record.errors === "string") return [record.errors];
  if (typeof record.errors === "object" && record.errors !== null) {
    return Object.entries(record.errors as Record<string, unknown>).flatMap(([field, value]) =>
      (Array.isArray(value) ? value : [value]).map((entry) => `${field}: ${String(entry)}`),
    );
  }
  return [];
}

function joinAddresses(addresses: string[]): string | undefined {
  return addresses.length > 0 ? addresses.join(",") : undefined;
}

const EVENT_STATUS: Record<string, NormalizedEvent["status"]> = {
  queued: "sent",
  delivered: "delivered",
  deferred: "deferred",
  bounced: "bounced",
  spam: "complained",
};

/**
 * Mailpace sends no event id; the message, the event and its timestamp identify one. Without a
 * timestamp, the signed body stands in for it, so only a byte-identical retry dedupes.
 */
function mailpaceEventId(messageId: string, status: string, updatedAt: unknown, rawBody: string): string {
  const stamp = updatedAt ? String(updatedAt) : `body-${createHash("sha256").update(rawBody).digest("hex")}`;
  return `${messageId}:${status}:${stamp}`;
}

/**
 * Mailpace's `to` is one string — the full To header, comma-separated when there's more than
 * one recipient — so it only tells us the address an event is about when there was exactly one
 * to tell. With more than one, the header can't say which recipient the event names.
 */
function recipientsNamed(to: unknown): string[] {
  if (typeof to !== "string") return [];
  const addresses = to
    .split(",")
    .map((one) => one.trim())
    .filter((one) => one.length > 0);
  return addresses.length === 1 ? addresses : [];
}

/** DER header for an Ed25519 SPKI key, so a raw 32-byte key can be read by node:crypto. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const SIGNATURE_HEADER = "x-mailpace-signature";
const SIGNATURE_BYTES = 64;

/** Reads a header whatever case the provider sent it in. */
function header(headers: Record<string, string>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

const log = logger.child("provider:mailpace");

/** Mailpace shows the webhook key as raw base64. A pasted PEM works too. */
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

/**
 * Ed25519 over the raw body, checked against whichever public key applies — the account's for
 * delivery events, a domain's own for inbound (Mailpace hands out one keypair per domain).
 * `label` is only for the log line.
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

const create: AdapterFactory = (credentials, settings, accountId): Adapter => {
  const { serverToken, organizationToken } = credentials as unknown as MailpaceCredentials;
  const webhookPublicKey = settings.webhookPublicKey;

  interface Called {
    response: Response;
    /** Parsed JSON body, or null when the body isn't JSON. */
    body: unknown;
  }

  /** One request, headers and body both inside the timeout, so a stalled body can't outlive it. */
  async function call(path: string, init: RequestInit, token: string, header: string): Promise<Called> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Mailpace request timed out after ${SEND_TIMEOUT_MS}ms.`)),
      SEND_TIMEOUT_MS,
    );
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          [header]: token,
          ...(init.headers as Record<string, string> | undefined),
        },
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch (err) {
        if (controller.signal.aborted) throw controller.signal.reason ?? err;
      }
      return { response, body };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function send(message: OutboundMessage): Promise<Receipt> {
    const payload: Record<string, unknown> = {
      from: formatAddress(message.from),
      to: message.to.join(","),
      cc: joinAddresses(message.cc),
      bcc: joinAddresses(message.bcc),
      replyto: joinAddresses(message.replyTo),
      subject: message.subject,
      htmlbody: message.html ?? undefined,
      textbody: message.text ?? undefined,
      tags: message.tags.length > 0 ? message.tags : undefined,
      attachments:
        message.attachments.length > 0
          ? message.attachments.map((attachment) => ({
              name: attachment.filename,
              content: attachment.content,
              content_type: attachment.contentType,
            }))
          : undefined,
    };

    let response: Response;
    let body: unknown;
    try {
      ({ response, body } = await call("/send", { method: "POST", body: JSON.stringify(payload) }, serverToken, "MailPace-Server-Token"));
    } catch (err) {
      return { successful: false, errors: [(err as Error).message], failure: "transient" };
    }

    if (response.ok) {
      const success = body as SendSuccess | null;
      if (!success?.id) {
        return { successful: false, errors: ["Provider accepted the message without an id."], failure: "transient" };
      }
      return { successful: true, providerMessageId: String(success.id) };
    }

    const errors = readErrors(body);
    if (errors.length === 0) errors.push(`HTTP ${response.status}`);

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        successful: false,
        errors,
        failure: "backoff",
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60,
      };
    }
    if (response.status >= 500) {
      return { successful: false, errors, failure: "transient" };
    }
    return { successful: false, errors, failure: "permanent" };
  }

  /**
   * The organization token is what the domains API takes, so it's the only credential here with
   * anything cheap to call. A server-token-only account (the common case — one token per domain,
   * copied from Mailpace's dashboard) has no read endpoint to probe, so it reports null rather than
   * guessing; lib/health leans on send outcomes for those instead.
   */
  async function healthCheck(): Promise<AdapterHealth> {
    if (!organizationToken) {
      return { ok: null, detail: "Mailpace authenticates per domain; with no organization token there's nothing account-wide to check. Health comes from send outcomes." };
    }
    try {
      const { response } = await call("/domains", { method: "GET" }, organizationToken, "MailPace-Organization-Token");
      if (response.ok) return { ok: true, detail: null };
      if (response.status === 401 || response.status === 403) return { ok: false, detail: "Credentials were rejected." };
      if (response.status === 429) return { ok: false, detail: "Rate limited by the provider." };
      return { ok: false, detail: "Provider unreachable or returned an error." };
    } catch {
      return { ok: false, detail: "Provider unreachable or returned an error." };
    }
  }

  function requireOrganizationToken(): string {
    if (!organizationToken) {
      throw new DomainApiUnavailableError("This provider has no organization token, and Mailpace's domains API needs one.");
    }
    return organizationToken;
  }

  // `verify` below reports `verified: body.dkim_verified === true` — the DKIM TXT is what gates
  // it, so it's the only required record here. Mailpace's return-path CNAME and SPF TXT improve
  // deliverability but aren't checked.
  function recordsFor(domain: Record<string, unknown>, name: string): ProposedDnsRecord[] {
    const records: ProposedDnsRecord[] = [];
    if (typeof domain.dkim_host === "string" && typeof domain.dkim_value === "string") {
      records.push({ type: "TXT", name: domain.dkim_host, value: domain.dkim_value, required: true });
    }
    if (typeof domain.return_path_domain === "string" && typeof domain.return_path_value === "string") {
      records.push({ type: "CNAME", name: domain.return_path_domain, value: domain.return_path_value, required: false });
    }
    if (typeof domain.spf_value === "string") {
      records.push({ type: "TXT", name, value: domain.spf_value, merge: "spf", required: false });
    }
    return records;
  }

  return {
    adapter: "mailpace",
    capabilities,
    send,
    canHealthCheck: Boolean(organizationToken),
    healthCheck,
    domain: {
      async create(name: string): Promise<CreatedDomain> {
        const { response, body: raw } = await call(
          "/domains",
          { method: "POST", body: JSON.stringify({ domain: { name, url: name } }) },
          requireOrganizationToken(),
          "MailPace-Organization-Token",
        );
        const body = raw as Record<string, unknown> | null;
        if (!response.ok || !body) {
          throw new Error(`${readErrors(body).join("; ") || `HTTP ${response.status}`}.`);
        }
        return { providerDomainId: body.id ? String(body.id) : null, records: recordsFor(body, name) };
      },

      async verify(name: string, providerDomainId: string | null): Promise<VerificationStatus> {
        if (!providerDomainId) {
          return { answered: false, verified: false, missing: [], errors: ["Domain has no provider id. Create it first."] };
        }
        let response: Response;
        let raw: unknown;
        try {
          ({ response, body: raw } = await call(
            `/domains/${providerDomainId}/verify`,
            { method: "POST" },
            requireOrganizationToken(),
            "MailPace-Organization-Token",
          ));
        } catch (err) {
          return { answered: false, verified: false, missing: [], errors: [(err as Error).message] };
        }

        const body = raw as Record<string, unknown> | null;
        if (!response.ok || !body) {
          const errors = readErrors(body);
          return { answered: false, verified: false, missing: [], errors: errors.length > 0 ? errors : [`HTTP ${response.status}`] };
        }
        const errors = Object.values((body.errors as Record<string, string>) ?? {});
        return { answered: true, verified: body.dkim_verified === true, missing: recordsFor(body, name), errors };
      },

      // No remove: Mailpace has no delete endpoint for a domain. removalViaApi says so, and
      // the setup steps tell the operator to remove it in the dashboard.
    },
    events: {
      /** Ed25519 over the raw body, against the webhook key on the domain's provider. */
      async verify(request: SignedRequest): Promise<boolean> {
        return verifyEd25519(request.rawBody, request.headers, webhookPublicKey, accountId);
      },
      parse(request: SignedRequest): NormalizedEvent[] {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(request.rawBody) as Record<string, unknown>;
        } catch {
          log.warn(`account ${accountId} sent a signed webhook body that isn't valid JSON`);
          return [];
        }
        const payload = (body.payload ?? body) as Record<string, unknown>;
        // Mailpace names the event "email.delivered" and repeats it as payload.status.
        const name = String(body.event ?? payload.status ?? "").replace(/^email\./, "");
        const status = EVENT_STATUS[name] ?? EVENT_STATUS[String(payload.status ?? "")];
        if (!status || !payload.id) return [];
        return [
          {
            providerMessageId: String(payload.id),
            providerEventId: mailpaceEventId(String(payload.id), status, payload.updated_at, request.rawBody),
            status,
            reason: typeof payload.error === "string" ? payload.error : null,
            occurredAt: new Date(String(payload.updated_at ?? Date.now())),
            detail: payload,
            recipients: recipientsNamed(payload.to),
          },
        ];
      },
    },
    inbound: {
      // Mailpace's inbound docs (docs.mailpace.com/guide/inbound) ask for a CNAME, not an MX
      // record: the inbound subdomain points at inbound.mailpace.com, and Mailpace's own mail
      // servers pick it up from there. required: false — inbound is opt-in and never blocks the
      // domain's own send verification.
      records(host: string): ProposedDnsRecord[] {
        return [{ type: "CNAME", name: host, value: "inbound.mailpace.com", required: false }];
      },
      // Same Ed25519 scheme as delivery events (verified against docs.mailpace.com/guide/webhooks
      // and docs.mailpace.com/guide/inbound), but keyed by the domain's own webhook keypair —
      // Mailpace hands out one per domain, not one per account.
      verify(request: SignedRequest, domainSettings: Record<string, string>): boolean {
        return verifyEd25519(request.rawBody, request.headers, domainSettings.webhookPublicKey, accountId);
      },
      parse(request: SignedRequest): NormalizedInboundMessage[] {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(request.rawBody) as Record<string, unknown>;
        } catch {
          log.warn(`account ${accountId} sent a signed inbound webhook body that isn't valid JSON`);
          return [];
        }
        const fromRaw = typeof body.from === "string" ? body.from : "";
        const from = parseAddress(fromRaw) ?? { name: null, address: fromRaw };
        const raw = typeof body.raw === "string" ? Buffer.from(body.raw, "utf8") : null;
        // Mailpace sends no envelope recipient. To, Cc and Bcc are the fields it fills; the
        // delivered-to headers are best-effort and only ever add.
        const fields = ["to", "cc", "bcc"].map((field) => (typeof body[field] === "string" ? (body[field] as string) : null));
        const to = [...new Set([...parseRecipients(fields), ...envelopeHints(headerLines(body.headers), raw?.toString("utf8") ?? null)])];
        const headers = headerRecord(body.headers);
        const attachments = Array.isArray(body.attachments) ? (body.attachments as Record<string, unknown>[]) : [];
        // Mailpace's inbound payload carries no id of its own; a retry carries the same raw message.
        const providerMessageId =
          typeof body.id === "string" || typeof body.id === "number"
            ? String(body.id)
            : raw
              ? `sha256:${createHash("sha256").update(raw).digest("hex")}`
              : null;

        return [
          {
            providerMessageId,
            from,
            to,
            subject: typeof body.subject === "string" ? body.subject : "",
            text: typeof body.text === "string" ? body.text : null,
            html: typeof body.html === "string" ? body.html : null,
            headers,
            messageId: typeof body.messageId === "string" ? body.messageId : null,
            inReplyTo: typeof body.inReplyTo === "string" ? body.inReplyTo : null,
            attachments: attachments.flatMap((attachment) => {
              const content = attachment.content;
              const filename = attachment.filename;
              const contentType = attachment.contentType ?? attachment.type;
              if (typeof content !== "string" || typeof filename !== "string" || typeof contentType !== "string") return [];
              return [{ filename, contentType, content: Buffer.from(content, "base64") }];
            }),
            raw,
            verdicts: null,
          },
        ];
      },
    },
  };
};

/** Mailpace's headers as `Name: value` lines, repeats included. */
function headerLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((line): line is string => typeof line === "string");
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([name, one]) => (typeof one === "string" ? [`${name}: ${one}`] : []));
  }
  return [];
}

/** Mailpace sends headers as `Name: value` lines. The first of a repeated name wins. */
function headerRecord(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const line of value) {
      if (typeof line !== "string") continue;
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim();
      if (!(name in headers)) headers[name] = line.slice(colon + 1).trim();
    }
    return headers;
  }
  if (value && typeof value === "object") {
    for (const [name, one] of Object.entries(value)) if (typeof one === "string") headers[name] = one;
  }
  return headers;
}

export const mailpace: AdapterModule = {
  adapter: "mailpace",
  capabilities,
  capabilitiesWith: (credentials) =>
    credentials.organizationToken ? capabilities : { ...capabilities, domainsViaApi: false, dnsRecordsViaApi: false },
  credentialsSchema,
  settingsSchema,
  create,
};
