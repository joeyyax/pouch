/**
 * The token that goes out on the wire: export headers, export filenames, the MCP server name and
 * the class names inside mail we send. Frozen — it stays `pouch` even if the product is renamed.
 * Display copy comes from `lib/brand.ts` instead, which is free to change.
 */
export const WIRE_TOKEN = "pouch";

/** The same token, header-cased. Mail header names are case-insensitive; this is the spelling we emit. */
export const WIRE_HEADER_TOKEN = "Pouch";

/** Headers on an exported .eml. A consumer parses these, so the names are a contract. */
export const WIRE_HEADERS = {
  messageId: `X-${WIRE_HEADER_TOKEN}-Message-Id`,
  messageStatus: `X-${WIRE_HEADER_TOKEN}-Message-Status`,
  bodyStatus: `X-${WIRE_HEADER_TOKEN}-Body-Status`,
  bodyReason: `X-${WIRE_HEADER_TOKEN}-Body-Reason`,
} as const;

/** Marks an SMTP submission sensitive. Read and stripped at ingress, never sent on. */
export const SENSITIVE_HEADER = `X-${WIRE_HEADER_TOKEN}-Sensitive`;

/** `pouch-messages-2026-09-18.csv`. A pipeline picking an export out of a folder matches the leading token. */
export function exportFilename(kind: "messages" | "bodies" | "data", stamp: string, extension: string): string {
  return `${WIRE_TOKEN}-${kind}-${stamp}.${extension}`;
}

/** A class name in the frame around mail we send, so it ships in the HTML a recipient receives. */
export function wireClass(name: "page" | "card" | "text" | "brand" | "footer"): string {
  return `${WIRE_TOKEN}-${name}`;
}
