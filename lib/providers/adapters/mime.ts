import { randomBytes } from "node:crypto";
import type { OutboundAddress, OutboundMessage } from "./types";

const CRLF = "\r\n";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Header values can never carry a line break, whatever the caller sent. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** RFC 2047 encodes a header value that isn't plain ASCII. */
function encodeHeader(value: string): string {
  const clean = oneLine(value);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** RFC 5322 specials, which a display name can only carry inside quotes. */
const SPECIALS = /[()<>[\]:;@\\,."]/;

/** A display name as a phrase: quoted when it carries specials, encoded when it isn't ASCII. */
export function displayName(name: string): string {
  const clean = oneLine(name);
  if (!/^[\x20-\x7E]*$/.test(clean)) return encodeHeader(clean);
  return SPECIALS.test(clean) ? `"${clean.replace(/(["\\])/g, "\\$1")}"` : clean;
}

function formatAddress(address: OutboundAddress): string {
  if (!address.name) return oneLine(address.address);
  return `${displayName(address.name)} <${oneLine(address.address)}>`;
}

/** RFC 5322 date, always in UTC. */
function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

function base64Body(content: Buffer | string): string {
  const encoded = typeof content === "string" ? Buffer.from(content, "utf8").toString("base64") : content.toString("base64");
  return (encoded.match(/.{1,76}/g) ?? []).join(CRLF);
}

function newBoundary(): string {
  return `----part-${randomBytes(12).toString("hex")}`;
}

interface Part {
  headers: string[];
  body: string;
}

const QP_LINE = 76;

/**
 * RFC 2045 quoted-printable. Text stays legible in anything that opens the file, which base64
 * doesn't — an exported .eml is read by people, not only by mail clients.
 */
export function quotedPrintable(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  return lines
    .map((line) => {
      let out = "";
      let width = 0;
      const bytes = Buffer.from(line, "utf8");
      for (const [index, byte] of bytes.entries()) {
        const printable = byte >= 0x20 && byte <= 0x7e && byte !== 0x3d;
        const trailingSpace = (byte === 0x20 || byte === 0x09) && index === bytes.length - 1;
        const token = printable && !trailingSpace ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        // A soft break can't split an escape, so the whole token moves to the next line.
        if (width + token.length > QP_LINE - 1) {
          out += `=${CRLF}`;
          width = 0;
        }
        out += token;
        width += token.length;
      }
      return out;
    })
    .join(CRLF);
}

function textPart(contentType: string, content: string): Part {
  return {
    headers: [`Content-Type: ${contentType}; charset=utf-8`, "Content-Transfer-Encoding: quoted-printable"],
    body: quotedPrintable(content),
  };
}

function attachmentPart(filename: string, contentType: string, content: string): Part {
  const name = encodeHeader(filename).replace(/"/g, "");
  return {
    headers: [
      `Content-Type: ${oneLine(contentType)}; name="${name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${name}"`,
    ],
    body: base64Body(Buffer.from(content, "base64")),
  };
}

function multipart(subtype: string, parts: Part[]): Part {
  const boundary = newBoundary();
  const body = parts
    .map((part) => `--${boundary}${CRLF}${part.headers.join(CRLF)}${CRLF}${CRLF}${part.body}`)
    .join(CRLF)
    .concat(`${CRLF}--${boundary}--`);
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`], body };
}

/** The body of the message: one part, an alternative of two, or a mixed tree with attachments. */
function bodyPart(message: OutboundMessage): Part {
  const bodies: Part[] = [];
  // An empty string is the caller's explicit "html only" choice (see html-to-text.ts), not a
  // part to send: an empty text/plain alternative would still trip the same spam heuristic
  // this exists to avoid, while claiming falsely that a plain-text version was provided.
  if (message.text !== null && message.text !== "") bodies.push(textPart("text/plain", message.text));
  if (message.html !== null) bodies.push(textPart("text/html", message.html));
  const content = bodies.length > 1 ? multipart("alternative", bodies) : (bodies[0] ?? textPart("text/plain", ""));

  if (message.attachments.length === 0) return content;
  return multipart("mixed", [
    content,
    ...message.attachments.map((attachment) =>
      attachmentPart(attachment.filename, attachment.contentType, attachment.content),
    ),
  ]);
}

/**
 * Builds an RFC 5322 message from an outbound envelope. Bcc is left out: it travels in the
 * provider's destination list, never in the body every recipient can read.
 */
export function buildMime(message: OutboundMessage, now = new Date()): string {
  const content = bodyPart(message);
  const headers = [
    `From: ${formatAddress(message.from)}`,
    `To: ${message.to.map(oneLine).join(", ")}`,
    ...(message.cc.length > 0 ? [`Cc: ${message.cc.map(oneLine).join(", ")}`] : []),
    ...(message.replyTo.length > 0 ? [`Reply-To: ${message.replyTo.map(oneLine).join(", ")}`] : []),
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${formatDate(now)}`,
    "MIME-Version: 1.0",
    ...Object.entries(message.headers).map(([name, value]) => `${oneLine(name)}: ${encodeHeader(value)}`),
    ...content.headers,
  ];

  return `${headers.join(CRLF)}${CRLF}${CRLF}${content.body}${CRLF}`;
}
