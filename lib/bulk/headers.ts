import { hostedUnsubscribeUrl } from "@/lib/api/urls";

/**
 * RFC 8058 one-click unsubscribe headers for one recipient of a batch. `List-Unsubscribe-Post`
 * always points at the hosted page — a mail client POSTs there directly, with nobody signed in
 * on the other end, so it has to work with no key and no branded-page redirect in between. The
 * `unsubscribeUrl` param only ever changes the `List-Unsubscribe` link a person clicks.
 */
export function unsubscribeHeaders(token: string, unsubscribeUrl: string | null): { "List-Unsubscribe": string; "List-Unsubscribe-Post": string } {
  const hosted = hostedUnsubscribeUrl(token);
  const clickUrl = unsubscribeUrl ? `${unsubscribeUrl}${unsubscribeUrl.includes("?") ? "&" : "?"}token=${token}` : hosted;
  return {
    "List-Unsubscribe": `<${clickUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
