/**
 * The domain lists Pouch checks and what their answers mean. Pure, so the return-code handling is
 * testable without DNS.
 *
 * Return codes: https://www.spamhaus.org/faqs/domain-blocklist/ (DBL),
 * https://www.spamhaus.org/faqs/dnsbl-usage/ (127.255.255.x errors) and
 * https://docs.spamhaus.com/datasets/docs/source/70-access-methods/data-query-service/040-dqs-queries.html (query format).
 */

export const BLOCKLISTS = ["dbl", "zrd"] as const;
export type BlocklistId = (typeof BLOCKLISTS)[number];

export interface BlocklistInfo {
  id: BlocklistId;
  label: string;
  /** DQS zone under the key: `<domain>.<key>.<zone>`. */
  zone: string;
  removalUrl: string | null;
}

export const BLOCKLIST_INFO: Record<BlocklistId, BlocklistInfo> = {
  dbl: { id: "dbl", label: "Spamhaus DBL", zone: "dbl.dq.spamhaus.net", removalUrl: "https://check.spamhaus.org" },
  // ZRD listings expire on their own 24 hours after Spamhaus first sees the domain.
  zrd: { id: "zrd", label: "Spamhaus ZRD", zone: "zrd.dq.spamhaus.net", removalUrl: null },
};

/** Spamhaus's permanent DBL test entry, answered 127.0.1.2. */
export const DBL_TEST_DOMAIN = "dbltest.com";
export const DBL_TEST_CODE = "127.0.1.2";

const DBL_REASONS: Record<string, string> = {
  "127.0.1.2": "spam domain",
  "127.0.1.4": "phish domain",
  "127.0.1.5": "malware domain",
  "127.0.1.6": "botnet C&C domain",
  "127.0.1.102": "abused legit spam",
  "127.0.1.103": "abused spammed redirector domain",
  "127.0.1.104": "abused legit phish",
  "127.0.1.105": "abused legit malware",
  "127.0.1.106": "abused legit botnet C&C",
};

/** Why a query produced no verdict. `refused` and `key_invalid` mean the key or resolver is the problem. */
export type CheckErrorKind = "refused" | "rate_limited" | "key_invalid" | "unexpected_code" | "timeout" | "lookup_failed";

export type Verdict =
  | { kind: "clear" }
  | { kind: "listed"; code: string; reason: string; /** ZRD only: hours since Spamhaus first saw the domain. */ ageHours?: number }
  | { kind: "error"; error: CheckErrorKind; code?: string };

/**
 * One list's answer, from the A records a lookup returned. An empty answer is NXDOMAIN: not listed.
 * Anything in 127.255.255.0/24 is an error about the query, never a listing.
 */
export function classifyAnswer(list: BlocklistId, addresses: string[]): Verdict {
  if (addresses.length === 0) return { kind: "clear" };

  const error = addresses.find((address) => address.startsWith("127.255.255."));
  if (error) {
    // 252 is a malformed zone name, which under DQS means the key segment is wrong.
    if (error === "127.255.255.252") return { kind: "error", error: "key_invalid", code: error };
    if (error === "127.255.255.254") return { kind: "error", error: "refused", code: error };
    if (error === "127.255.255.255") return { kind: "error", error: "rate_limited", code: error };
    return { kind: "error", error: "refused", code: error };
  }

  if (list === "dbl") {
    const code = addresses.find((address) => address in DBL_REASONS);
    if (code) return { kind: "listed", code, reason: DBL_REASONS[code]! };
    return { kind: "error", error: "unexpected_code", code: addresses[0] };
  }

  // ZRD answers 127.0.2.2 to 127.0.2.24, the last octet being the domain's age in hours.
  for (const address of addresses) {
    const match = /^127\.0\.2\.(\d+)$/.exec(address);
    const hours = match ? Number(match[1]) : NaN;
    if (hours >= 2 && hours <= 24) {
      return { kind: "listed", code: address, reason: "newly registered or newly active domain", ageHours: hours };
    }
  }
  return { kind: "error", error: "unexpected_code", code: addresses[0] };
}

/** DQS keys are lowercase alphanumeric. Anything else would change the query name. */
export function validKey(key: string): boolean {
  return /^[a-z0-9]{16,64}$/.test(key);
}

/** The DNS name to query, or null for a name that isn't a queryable domain. */
export function queryName(list: BlocklistId, domain: string, key: string): string | null {
  const name = normalizeDomain(domain);
  if (!name || !validKey(key)) return null;
  return `${name}.${key}.${BLOCKLIST_INFO[list].zone}`;
}

/** Lowercased, trailing dot removed. Null for IP literals, single labels and anything with odd characters. */
export function normalizeDomain(domain: string): string | null {
  const name = domain.trim().toLowerCase().replace(/\.$/, "");
  if (name.length === 0 || name.length > 200) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) return null;
  if (/^[0-9.]+$/.test(name)) return null;
  if (/^[0-9]+$/.test(name.split(".").at(-1)!)) return null;
  return name;
}
