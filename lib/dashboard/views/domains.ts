/**
 * The shapes the domains screen renders, and the pure helpers it calls.
 *
 * lib/dashboard/views is the client boundary: every value a screen needs at runtime lives here,
 * and nothing under it imports a module that reaches Postgres, object storage or Redis. A value
 * imported from one of those into a "use client" file drags the Postgres driver into the browser
 * bundle — which typecheck and lint both allow, and only the browser catches. Types are erased,
 * so a client component may still import one from a loader.
 */
import type { DomainStatus, SuppressionReason } from "@/lib/db/schema";
import type { DomainContents, DomainDeleteBlock } from "@/lib/domains/deletable";
import type { DomainLayout } from "@/lib/domains/layout";
import type { ProposedDnsRecord, SetupStep } from "@/lib/providers/adapters/types";
import type { Finding, Standing } from "@/lib/reputation/standing";
import type { DomainStallView } from "@/lib/domains/guard";

export type { DnsRecordCheck, DnsVerdict, DnsErrorKind } from "@/lib/domains/dns-check";
export { domainStallView } from "@/lib/domains/guard";
export type { DomainStallView };
export { RATE_WINDOW_DAYS } from "@/lib/metrics/window";
export { ADAPTER_LABEL, adapterLabel } from "@/lib/providers/labels";

export const recordKey = (record: ProposedDnsRecord) => `${record.type}:${record.name}`;

/** Every record as one zone file, for copy-all. A merge record carries its warning as a comment. */
export function zoneFile(records: ProposedDnsRecord[]): string {
  return records
    .map((record) => {
      const line =
        record.type === "MX"
          ? `${record.name}. IN MX ${record.priority ?? 10} ${record.value}.`
          : record.type === "TXT"
            ? `${record.name}. IN TXT "${record.value}"`
            : `${record.name}. IN CNAME ${record.value}.`;
      return record.merge === "spf"
        ? `; ${record.name} can have only one SPF record. Merge this into the record it has rather than adding a second.\n${line}`
        : line;
    })
    .join("\n");
}

export interface DomainListItem {
  id: string;
  name: string;
  status: DomainStatus;
  createdAt: Date;
  providerName: string;
  /** Delivery events in the window, and nothing else. */
  delivered: number;
  /** `delivered` per day in the viewer's zone, oldest first. */
  deliveredDaily: number[];
  bounced: number;
  complained: number;
  failed: number;
  /** Keys that can send from this domain: scoped to it, or scoped to nothing. */
  keyCount: number;
  /** A move to another provider is in progress. */
  moving: boolean;
  /** The stall guard is holding this domain's queue. Null means it's sending normally. */
  stall: DomainStallView | null;
  standing: Standing;
  /** One sentence on why it isn't healthy. Null when it is. */
  standingReason: string | null;
}

/** The domain page's compact reputation line: the standing and the one finding that leads. */
export interface DomainStandingSummary {
  standing: Standing;
  lead: Finding | null;
}

export interface DomainPendingBinding {
  providerId: string;
  providerName: string;
  adapterLabel: string;
  dnsRecords: ProposedDnsRecord[];
  /** Records the last answered check on the target couldn't see, keyed `type:name`. */
  missingRecords: string[];
  startedAt: Date;
}

export interface DomainKeySummary {
  id: string;
  name: string;
  mode: "live" | "test";
  revoked: boolean;
}

/** The Sending section's keys. */
export interface DomainKeys {
  /** Keys limited to this domain, revoked ones included. */
  keys: DomainKeySummary[];
  /** Live keys limited to no domain, which can send from here too. */
  unscopedKeys: number;
}

export interface DomainSuppressionSummary {
  id: string;
  address: string;
  reason: SuppressionReason;
  createdAt: Date;
}

export interface DomainDetailData {
  id: string;
  name: string;
  status: DomainStatus;
  dnsRecords: ProposedDnsRecord[];
  /** Records the last answered check couldn't see, keyed `type:name`. */
  missingRecords: string[];
  verificationErrors: string[];
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
  /** The frame a send with `layout: true` is wrapped in. */
  layout: DomainLayout | null;
  provider: { id: string; name: string; adapter: string; adapterLabel: string };
  /** What the provider can't finish through its API, worded for the organization. */
  setup: SetupStep[];
  /** Live keys limited to this domain, named in the delete dialog. Null when the domain can't be deleted. */
  liveScopedKeys: DomainKeySummary[] | null;
  /** What stops this domain being deleted: mail waiting to send, or system mail. Null when it can be. */
  deleteBlock: DomainDeleteBlock | null;
  /** What a delete takes with it. Null while something blocks the delete. */
  deleteContents: DomainContents | null;
  /** Whether the adapter can answer a verification check at all. */
  verifiable: boolean;
  /** A move to another provider in progress. Null when there isn't one. */
  pending: DomainPendingBinding | null;
  /** The stall guard is holding this domain's queue. Null means it's sending normally. */
  stall: DomainStallView | null;
  /** Operator opt-in for bulk sending (#246). Off by default. */
  bulkAllowed: boolean;
  /** Whether this domain's provider adapter can do bulk at all — gates the toggle itself. */
  bulkCapable: boolean;
}

export interface ProviderOption {
  id: string;
  name: string;
  adapter: string;
  adapterLabel: string;
  /** False when the adapter can't create a domain through its API. */
  canAddDomains: boolean;
  /** The organization's assigned provider, which a new domain binds to by default. */
  assigned: boolean;
}
