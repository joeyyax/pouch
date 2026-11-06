import type { domains } from "@/lib/db/schema";
import type { ProposedDnsRecord, SetupStep } from "@/lib/providers/adapters/types";
import type { Standing } from "@/lib/reputation/standing";
import type { SerializedDomainReputation } from "@/lib/reputation/serialize";
import { withDmarc, type SerializedDmarc } from "./dmarc";
import { domainStallView, type StallReason } from "./guard";
import { serializeLayout, type SerializedLayout } from "./layout";
import { domainSetup } from "./setup";
import { markMerges } from "./spf";

type DomainRow = typeof domains.$inferSelect;

export interface SerializedDnsRecord {
  type: ProposedDnsRecord["type"];
  name: string;
  value: string;
  priority?: number;
  /** Present when this record merges into one the name may already have. */
  merge?: "spf";
  /** Whether the domain fails to verify without this record. */
  required: boolean;
}

export interface SerializedStall {
  reason: StallReason;
  /** One sentence: what fired and the numbers behind it. */
  message: string;
  stalled_at: string;
}

export interface SerializedPendingBinding {
  provider_id: string;
  /** DNS records the pending provider asked for. */
  dns_records: SerializedDnsRecord[];
  /** Records the last answered check on the pending provider couldn't see. */
  missing_records: SerializedDnsRecord[];
  started_at: string;
}

export interface SerializedDomain {
  id: string;
  name: string;
  status: DomainRow["status"];
  dns_records: SerializedDnsRecord[];
  /** Records the provider still can't see. Filled by a verification check. Never lists the DMARC record, which `dmarc` reports. */
  missing_records: SerializedDnsRecord[];
  /** What the provider can't finish through its API, worded for the organization. */
  setup: SetupStep[];
  /** Provider reasons for a `failed` status. Empty once verification succeeds. */
  errors: string[];
  verified_at: string | null;
  last_checked_at: string | null;
  created_at: string;
  /** The provider this domain sends through now. */
  provider_id: string;
  /** A move to another provider in progress. Null when there isn't one. */
  pending: SerializedPendingBinding | null;
  /** Sending is held on this domain (#94). Accepting continues; queued sends wait. Null means normal. */
  stall: SerializedStall | null;
  /** Explicit operator opt-in for bulk sending (#246). Off by default on every domain. */
  bulk_allowed: boolean;
  /** The frame a send with `layout: true` is wrapped in. Null when there isn't one. */
  layout: SerializedLayout | null;
  standing: Standing;
  /** One sentence on why the domain isn't healthy. Null when it is. */
  standing_reason: string | null;
  /** The `reputation` expansion, on a single read that asks for it. */
  reputation?: SerializedDomainReputation | null;
  /** What the domain's DMARC record says, read live. On a verify call and the `dmarc` expansion. */
  dmarc?: SerializedDmarc;
}

function record(entry: ProposedDnsRecord): SerializedDnsRecord {
  return {
    type: entry.type,
    name: entry.name,
    value: entry.value,
    required: entry.required,
    ...(entry.priority === undefined ? {} : { priority: entry.priority }),
    ...(entry.merge === undefined ? {} : { merge: entry.merge }),
  };
}

export interface SerializeContext {
  adapter: string;
  providerId: string;
  /** Overrides the stored column with a live verify call's answer. Falls back to `domain.missingRecords`. */
  missing?: ProposedDnsRecord[];
  /** False when the adapter's own event plumbing hasn't finished. Adds a step to `setup`. */
  eventsConfigured?: boolean;
  reputation: DomainStandingSummary;
  /** The domain's address on the DMARC report host, which the recommended `_dmarc` record carries. */
  reportUri?: string | null;
}

export interface DomainStandingSummary {
  standing: Standing;
  reason: string | null;
}

export function serializeDomain(domain: DomainRow, context: SerializeContext): SerializedDomain {
  const stall = domainStallView(domain);
  return {
    id: domain.id,
    name: domain.name,
    status: domain.status,
    dns_records: withDmarc(markMerges(domain.dnsRecords, domain.name), domain.name, context.reportUri ?? null).map(record),
    missing_records: markMerges(context.missing ?? domain.missingRecords, domain.name).map(record),
    setup: domainSetup(context.adapter, context.providerId, context.eventsConfigured ?? true),
    errors: domain.verificationErrors,
    verified_at: domain.verifiedAt?.toISOString() ?? null,
    last_checked_at: domain.lastCheckedAt?.toISOString() ?? null,
    created_at: domain.createdAt.toISOString(),
    provider_id: domain.providerId,
    pending: domain.pendingProviderId
      ? {
          provider_id: domain.pendingProviderId,
          dns_records: markMerges(domain.pendingDnsRecords, domain.name).map(record),
          missing_records: markMerges(domain.pendingMissingRecords, domain.name).map(record),
          started_at: (domain.pendingStartedAt ?? domain.updatedAt).toISOString(),
        }
      : null,
    stall: stall ? { reason: stall.reason, message: stall.summary, stalled_at: stall.stalledAt.toISOString() } : null,
    bulk_allowed: domain.bulkAllowed,
    layout: domain.layout ? serializeLayout(domain.layout, domain.name) : null,
    standing: context.reputation.standing,
    standing_reason: context.reputation.reason,
  };
}
