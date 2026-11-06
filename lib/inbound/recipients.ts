import addressparser from "nodemailer/lib/addressparser";
import { isEmailAddress, normalizeAddress } from "@/lib/addresses";

type Parsed = ReturnType<typeof addressparser>;

function flatten(entries: Parsed): string[] {
  return entries.flatMap((entry) => ("group" in entry ? flatten(entry.group ?? []) : [entry.address]));
}

/** Bare, normalized, deduplicated addresses from address-list strings. Display names never survive. */
export function parseRecipients(fields: (string | null | undefined)[]): string[] {
  const found = fields.flatMap((field) => (field ? flatten(addressparser(field)) : []));
  return [...new Set(found.map(normalizeAddress).filter(isEmailAddress))];
}

const RECEIVED_FOR = /\sfor\s+(<[^<>\s]+>|[^\s;<>()]+@[^\s;<>()]+)/i;

/**
 * Best-effort envelope hints: `Delivered-To`, `X-Original-To` and the `for <addr>` clause of
 * `Received`, from header `Name: value` lines and the raw message's header block.
 */
export function envelopeHints(lines: string[], raw: string | null): string[] {
  const block = raw ? (raw.split(/\r?\n\r?\n/, 1)[0] ?? "").replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/) : [];
  const values = [...lines, ...block].flatMap((line) => {
    const colon = line.indexOf(":");
    if (colon <= 0) return [];
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "delivered-to" || name === "x-original-to") return [value];
    if (name === "received") return [RECEIVED_FOR.exec(value)?.[1] ?? ""];
    return [];
  });
  return parseRecipients(values);
}
