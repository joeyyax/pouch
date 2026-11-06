import { z } from "zod";
import type { ObservedDnsRecord, ProposedDnsRecord } from "@/lib/providers/adapters/types";
import {
  type DnsProvider,
  type DnsProviderCapabilities,
  type DnsProviderFactory,
  type DnsProviderModule,
  type DnsRecordRef,
  type DnsWriteResult,
  type DnsZone,
} from "./types";

/** Permissive by design: a test double shouldn't be the thing that rejects a request. */
const capabilities: DnsProviderCapabilities = {
  apexCname: true,
  nsWritable: false,
  zoneEnumeration: true,
};

const credentialsSchema = z.looseObject({});
const settingsSchema = z.looseObject({});

/** Zones this module answers with, keyed by name. Fixtures can add to this in a test. */
const zones = new Map<string, DnsZone>([
  ["example.com", { name: "example.com", id: "mock_zone_example.com" }],
  ["northgate.dev", { name: "northgate.dev", id: "mock_zone_northgate.dev" }],
]);

const records = new Map<string, ObservedDnsRecord[]>([
  [
    "example.com",
    [
      { id: "mock_rec_1", type: "TXT", name: "example.com", value: "v=spf1 include:mock.example.net ~all" },
      { id: "mock_rec_2", type: "CNAME", name: "mock._domainkey.example.com", value: "mock.dkim.example.net" },
    ],
  ],
]);

/** Adds a zone (and optionally its records) for a test to read back. Tests only. */
export function addMockZone(zone: DnsZone, zoneRecords: ObservedDnsRecord[] = []): void {
  zones.set(zone.name, zone);
  records.set(zone.name, zoneRecords);
}

let mockRecordCounter = 0;

/** Restores the mock to its default fixtures. Tests only. */
export function resetMockZones(): void {
  mockRecordCounter = 0;
  zones.clear();
  zones.set("example.com", { name: "example.com", id: "mock_zone_example.com" });
  zones.set("northgate.dev", { name: "northgate.dev", id: "mock_zone_northgate.dev" });
  records.clear();
  records.set("example.com", [
    { id: "mock_rec_1", type: "TXT", name: "example.com", value: "v=spf1 include:mock.example.net ~all" },
    { id: "mock_rec_2", type: "CNAME", name: "mock._domainkey.example.com", value: "mock.dkim.example.net" },
  ]);
}

const create: DnsProviderFactory = (): DnsProvider => ({
  module: "mock",
  capabilities,

  async listZones(): Promise<DnsZone[]> {
    return Array.from(zones.values());
  },

  async findZone(domain: string): Promise<DnsZone | null> {
    return zones.get(domain) ?? null;
  },

  async getRecords(zone: DnsZone, name?: string): Promise<ObservedDnsRecord[]> {
    const all = records.get(zone.name) ?? [];
    return name ? all.filter((record) => record.name === name) : all;
  },

  /** Same one-record-at-a-time, additive behavior as the Cloudflare adapter — see its `upsertRecords` for why. */
  async upsertRecords(zone: DnsZone, incoming: ProposedDnsRecord[]): Promise<DnsWriteResult[]> {
    const results: DnsWriteResult[] = [];
    const zoneRecords = records.get(zone.name) ?? [];
    for (const record of incoming) {
      try {
        const existing = zoneRecords.filter((candidate) => candidate.type === record.type && candidate.name === record.name);
        if (existing.length > 1) {
          throw new Error(`More than one ${record.type} record already exists at ${record.name}; refusing to guess which to update.`);
        }
        if (existing[0]) {
          existing[0].value = record.value;
          existing[0].priority = record.priority;
        } else {
          mockRecordCounter += 1;
          zoneRecords.push({ id: `mock_rec_${mockRecordCounter}`, type: record.type, name: record.name, value: record.value, priority: record.priority });
        }
        results.push({ name: record.name, type: record.type, status: "applied" });
      } catch (err) {
        results.push({ name: record.name, type: record.type, status: "failed", error: err instanceof Error ? err.message : String(err) });
      }
    }
    records.set(zone.name, zoneRecords);
    return results;
  },

  /** Same by-(type, name) delete as the Cloudflare adapter — see its `removeRecords` for why. */
  async removeRecords(zone: DnsZone, incoming: DnsRecordRef[]): Promise<void> {
    let zoneRecords = records.get(zone.name) ?? [];
    for (const record of incoming) {
      const existing = zoneRecords.filter((candidate) => candidate.type === record.type && candidate.name === record.name);
      if (existing.length === 0) continue;
      if (existing.length > 1) {
        throw new Error(`More than one ${record.type} record exists at ${record.name}; refusing to guess which to delete.`);
      }
      zoneRecords = zoneRecords.filter((candidate) => candidate.id !== existing[0]!.id);
    }
    records.set(zone.name, zoneRecords);
  },

  async healthCheck() {
    return { ok: true, detail: null };
  },
});

export const mock: DnsProviderModule = {
  module: "mock",
  capabilities,
  credentialsSchema,
  settingsSchema,
  create,
};
