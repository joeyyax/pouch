import type { AddressObject, ParsedMail } from "mailparser";
import { formatAddress, isEmailAddress, normalizeAddress } from "@/lib/addresses";
import type { SendEmailInput } from "@/lib/schemas/email";
import { RESERVED_HEADERS } from "@/lib/schemas/email";
import { SENSITIVE_HEADER } from "@/lib/wire";

const SENSITIVE_KEY = SENSITIVE_HEADER.toLowerCase();

/**
 * Flattens mailparser's `AddressObject | AddressObject[] | undefined` into normalized bare
 * addresses. mailparser has already split a multi-recipient header (`A <a@x>, B <b@y>`, a
 * quoted display name containing a comma included) into one entry per address, so this only
 * reads the structured result — it never re-splits header text itself.
 *
 * Display names are dropped here: `to`, `cc` and `reply_to` have nowhere to carry one —
 * `MessageEnvelope` (lib/db/schema/messages.ts) stores them as plain address arrays, and
 * `sendEmailSchema` only ever accepted bare addresses for these fields (unlike `from`, which
 * keeps a name via `fromName`). Formatting `Name <addr>` here just fails validation downstream.
 */
function addressStrings(field: AddressObject | AddressObject[] | undefined): string[] {
  const objects = Array.isArray(field) ? field : field ? [field] : [];
  return objects.flatMap((object) =>
    object.value.filter((entry) => Boolean(entry.address)).map((entry) => normalizeAddress(entry.address ?? "")),
  );
}

/**
 * Envelope recipients (`RCPT TO`) that never showed up in the `To` or `Cc` headers — a client
 * that submits with real Bcc addresses drops them from the headers but still hands them to
 * SMTP as recipients. Anything left over here becomes `bcc` on the send request, the same way
 * a caller would set it over HTTP.
 */
function bccFromEnvelope(rcptTo: string[], headerTo: string[], headerCc: string[]): string[] {
  const visible = new Set([...headerTo, ...headerCc].map(normalizeAddress));
  const seen = new Set<string>();
  return rcptTo.filter((address) => {
    const normalized = normalizeAddress(address);
    if (visible.has(normalized) || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/** Custom headers only: known fields (from, to, subject, ...) are mapped explicitly, and anything the service sets itself is dropped, exactly as `assertHeadersAllowed` would reject it if it came through the JSON API. */
function customHeaders(mail: ParsedMail): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const { key, line } of mail.headerLines) {
    if (RESERVED_HEADERS.has(key) || key === SENSITIVE_KEY) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    headers[key] = line.slice(colon + 1).trim();
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** `X-Pouch-Sensitive: 1` marks the message sensitive. Any other value leaves it unmarked. */
function isMarkedSensitive(mail: ParsedMail): boolean {
  return mail.headerLines.some(({ key, line }) => key === SENSITIVE_KEY && line.slice(line.indexOf(":") + 1).trim() === "1");
}

function attachmentsOf(mail: ParsedMail): SendEmailInput["attachments"] {
  if (mail.attachments.length === 0) return undefined;
  return mail.attachments.map((attachment) => ({
    filename: attachment.filename ?? "attachment",
    content: Buffer.from(attachment.content).toString("base64"),
    content_type: attachment.contentType,
  }));
}

export interface SmtpEnvelope {
  /** `MAIL FROM` address, used only when the message carries no `From` header at all. */
  mailFrom: string | null;
  /** Every `RCPT TO` address accepted during the session. */
  rcptTo: string[];
}

/**
 * Builds the same shape `POST /v1/emails` accepts from a parsed MIME message. Validation —
 * required fields, address syntax, header limits — happens once, downstream, when this is
 * run through `sendEmailSchema`: this function only maps, it doesn't reject.
 */
export function candidateFromParsedMail(mail: ParsedMail, envelope: SmtpEnvelope): SendEmailInput {
  const headerFrom = mail.from?.value[0];
  const from = headerFrom?.address
    ? formatAddress({ name: headerFrom.name || null, address: normalizeAddress(headerFrom.address) })
    : (envelope.mailFrom ?? "");

  const headerTo = addressStrings(mail.to);
  const headerCc = addressStrings(mail.cc);
  const bcc = bccFromEnvelope(envelope.rcptTo, headerTo, headerCc);
  const headers = customHeaders(mail);
  const attachments = attachmentsOf(mail);

  return {
    from,
    to: headerTo.length > 0 ? headerTo : envelope.rcptTo,
    ...(headerCc.length > 0 ? { cc: headerCc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    ...(mail.replyTo ? { reply_to: addressStrings(mail.replyTo) } : {}),
    subject: mail.subject ?? "",
    ...(mail.html !== false ? { html: mail.html } : {}),
    ...(mail.text !== undefined ? { text: mail.text } : {}),
    ...(headers ? { headers } : {}),
    ...(attachments ? { attachments } : {}),
    ...(isMarkedSensitive(mail) ? { sensitive: true } : {}),
  };
}

/** Rejects a syntactically invalid envelope address early, before a DATA stream is even read. */
export function isValidEnvelopeAddress(address: string): boolean {
  return isEmailAddress(normalizeAddress(address));
}
