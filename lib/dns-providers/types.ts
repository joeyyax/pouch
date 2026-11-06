import type { z } from "zod";
import type { AdapterHealth, DnsRecordType, ObservedDnsRecord, ProposedDnsRecord } from "@/lib/providers/adapters/types";

export type { DnsRecordType, ObservedDnsRecord, ProposedDnsRecord } from "@/lib/providers/adapters/types";
export type { AdapterHealth };

export interface DnsProviderCapabilities {
  /** Whether an apex name can hold a CNAME (flattened or native). */
  apexCname: boolean;
  /** Whether this module can touch NS records at all. No module writes them; this only says whether the API could. */
  nsWritable: boolean;
  /** Whether an account-scoped credential can list zones. A zone-scoped credential never can, regardless of this flag. */
  zoneEnumeration: boolean;
}

/** A zone as this module sees it. Past the adapter boundary, code identifies a zone by `name`, never `id`. */
export interface DnsZone {
  /** The zone's DNS name — google.com, not a provider-internal id. */
  name: string;
  /** Provider-internal zone id. Opaque outside the module; never persisted as the zone's identity. */
  id: string;
}

/** Identifies a record to remove, without its value — the value that's live is read back before the delete. */
export interface DnsRecordRef {
  type: DnsRecordType;
  name: string;
}

/** Outcome of one record write. */
export type DnsWriteResult =
  | { name: string; type: DnsRecordType; status: "applied" | "skipped" }
  | { name: string; type: DnsRecordType; status: "failed"; error: string };

/** Non-secret module config: an account id, a default zone id. Same shape as `ProviderSettings`. */
export type DnsProviderSettings = Record<string, string>;

/** Thrown by `listZones` when the credential in hand can't enumerate — a zone-scoped token. */
export class DnsNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnsNotSupportedError";
  }
}

export interface DnsProvider {
  /** Module key. Matches dns_provider_accounts.module. */
  readonly module: string;
  readonly capabilities: DnsProviderCapabilities;
  /** Throws `DnsNotSupportedError` when this credential can't enumerate zones. */
  listZones(): Promise<DnsZone[]>;
  findZone(domain: string): Promise<DnsZone | null>;
  getRecords(zone: DnsZone, name?: string): Promise<ObservedDnsRecord[]>;
  /** Writes each record additively, one at a time. Only ever called with records `applyDnsPlan` computed itself (#210). */
  upsertRecords(zone: DnsZone, records: ProposedDnsRecord[]): Promise<DnsWriteResult[]>;
  /** Called by lib/domains/dns-cleanup.ts. Route53 throws here until #211 — see that issue. */
  removeRecords(zone: DnsZone, records: DnsRecordRef[]): Promise<void>;
  /**
   * A real, cheap call that proves this account's credentials and reachability. Never throws.
   * Runs on a slow interval, same as `Adapter.healthCheck`.
   */
  healthCheck(): Promise<AdapterHealth>;
}

/** Builds a DNS provider from a decrypted credentials object and the account's settings. */
export type DnsProviderFactory = (
  credentials: Record<string, string>,
  settings: DnsProviderSettings,
  accountId: string,
) => DnsProvider;

/**
 * Everything the registry knows about a DNS module. Capabilities and the schemas sit here rather
 * than on `DnsProvider` so reading them never decrypts an account's credentials.
 */
export interface DnsProviderModule {
  /** Module key. Matches dns_provider_accounts.module. */
  module: string;
  capabilities: DnsProviderCapabilities;
  /** What the module needs to be configured with. The dashboard reads this. */
  credentialsSchema: z.ZodObject;
  settingsSchema: z.ZodObject;
  create: DnsProviderFactory;
}
