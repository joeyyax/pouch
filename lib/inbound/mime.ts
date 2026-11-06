import { simpleParser, type AddressObject } from "mailparser";
import type { InboundVerdicts, NormalizedInboundMessage } from "@/lib/providers/adapters/types";

function firstAddress(field: AddressObject | AddressObject[] | undefined): { name: string | null; address: string } | null {
  const objects = Array.isArray(field) ? field : field ? [field] : [];
  for (const object of objects) {
    for (const entry of object.value) {
      if (entry.address) return { name: entry.name || null, address: entry.address };
    }
  }
  return null;
}

/** Header lines as `name: value`, the first of a repeated name kept. */
function headerRecord(lines: readonly { key: string; line: string }[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { key, line } of lines) {
    if (key in headers) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    headers[key] = line.slice(colon + 1).replace(/\r?\n[ \t]+/g, " ").trim();
  }
  return headers;
}

function addressesOn(host: string, fields: (AddressObject | AddressObject[] | undefined)[]): string[] {
  const suffix = `@${host.toLowerCase()}`;
  const found = fields
    .flatMap((field) => (Array.isArray(field) ? field : field ? [field] : []))
    .flatMap((object) => object.value.map((entry) => entry.address ?? ""))
    .filter((address) => address.toLowerCase().endsWith(suffix));
  return [...new Set(found)];
}

/** One method's result from SES's own `Authentication-Results`, the first one on the message. */
function authResult(value: string | undefined, method: "spf" | "dkim" | "dmarc"): string | null {
  if (!value || !/^amazonses\.com\s*;/i.test(value)) return null;
  return new RegExp(`;\\s*${method}=([a-z]+)`, "i").exec(value)?.[1]?.toLowerCase() ?? null;
}

/** The verdict headers SES adds to a message it scanned. */
function verdictsFromHeaders(headers: Record<string, string>): InboundVerdicts | null {
  const spam = headers["x-ses-spam-verdict"]?.toLowerCase() ?? null;
  const virus = headers["x-ses-virus-verdict"]?.toLowerCase() ?? null;
  if (!spam && !virus) return null;
  const results = headers["authentication-results"];
  return { spam, virus, spf: authResult(results, "spf"), dkim: authResult(results, "dkim"), dmarc: authResult(results, "dmarc") };
}

export interface RawInboundContext {
  /** Envelope recipients. Empty falls back to the `To` and `Cc` addresses on `host`. */
  recipients: string[];
  host: string;
  providerMessageId: string;
  /** Null falls back to the verdict headers the provider added. */
  verdicts: InboundVerdicts | null;
}

/**
 * Normalizes a raw RFC 5322 message. The envelope's recipients name a Bcc'd or forwarded address
 * the headers don't, so they win when there are any.
 */
export async function parseRawInbound(raw: Buffer, context: RawInboundContext): Promise<NormalizedInboundMessage> {
  const mail = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const headers = headerRecord(mail.headerLines);
  return {
    providerMessageId: context.providerMessageId,
    from: firstAddress(mail.from) ?? { name: null, address: "" },
    to: context.recipients.length > 0 ? context.recipients : addressesOn(context.host, [mail.to, mail.cc]),
    subject: mail.subject ?? "",
    text: mail.text ?? null,
    html: typeof mail.html === "string" ? mail.html : null,
    headers,
    messageId: headers["message-id"] ?? null,
    inReplyTo: headers["in-reply-to"] ?? null,
    attachments: mail.attachments.map((attachment) => ({
      filename: attachment.filename ?? "attachment",
      contentType: attachment.contentType,
      content: attachment.content,
    })),
    raw,
    verdicts: context.verdicts ?? verdictsFromHeaders(headers),
  };
}
