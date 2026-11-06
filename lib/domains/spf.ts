import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";

/** Mechanisms costing a DNS lookup that SPF allows in one record. An eleventh is a permerror. */
export const SPF_LOOKUP_LIMIT = 10;

/** Mechanisms the receiver resolves. ip4, ip6 and exp cost nothing. */
const LOOKUP_TERM = /^(include:|exists:|redirect=|ptr(:|$)|a([:/]|$)|mx([:/]|$))/;

const ALL_TERM = /^[+\-~?]?all$/i;

export function isSpfValue(value: string): boolean {
  return /^v=spf1(\s|$)/i.test(value.trim());
}

/** The terms a record contributes, without the version tag or the trailing all. */
export function spfMechanisms(value: string): string[] {
  return value
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0 && !/^v=spf1$/i.test(term) && !ALL_TERM.test(term));
}

export function spfLookups(mechanisms: string[]): number {
  return mechanisms.filter((term) => LOOKUP_TERM.test(term.replace(/^[+\-~?]/, "").toLowerCase())).length;
}

/** The record's trailing qualifier mechanism (`+all`, `-all`, `~all`, `?all`), if it has one. */
export function spfAllTerm(value: string): string | null {
  return value.trim().split(/\s+/).find((term) => ALL_TERM.test(term)) ?? null;
}

/**
 * Marks an SPF record sitting at the domain's own name, where a domain sending through anything
 * else already has one. Records created before the marker existed are stored without it.
 */
export function markMerges(records: ProposedDnsRecord[], domainName: string): ProposedDnsRecord[] {
  return records.map((record) =>
    record.merge === undefined && record.type === "TXT" && record.name === domainName && isSpfValue(record.value)
      ? { ...record, merge: "spf" as const }
      : record,
  );
}

export interface SpfMergeGuidance {
  /** What to add to an existing record, for its own copy button. */
  mechanisms: string;
  note: string;
  /** Absent when nothing in the record resolves. */
  cost: string | null;
}

/** What the record list and the docs say about a record that has to merge. */
export function spfMergeGuidance(record: ProposedDnsRecord): SpfMergeGuidance {
  const mechanisms = spfMechanisms(record.value);
  const list = mechanisms.join(" ");
  const lookups = spfLookups(mechanisms);

  return {
    mechanisms: list,
    note: `${record.name} can have only one SPF record. Publish this value if it has none, and otherwise add ${list} to the record it has — a second SPF record fails SPF for all of this domain's mail.`,
    cost:
      lookups === 0
        ? null
        : `${list} ${lookups === 1 ? "costs 1" : `cost ${lookups}`} of the ${SPF_LOOKUP_LIMIT} DNS lookups SPF allows, so a record already at ${SPF_LOOKUP_LIMIT} needs one removed first.`,
  };
}
