import { Suspense, type ReactNode } from "react";
import { recordKey } from "@/lib/dashboard/views/domains";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { DnsCheckingFallback } from "./dns-records";
import { DnsLiveCheck } from "./dns-live-check";

/**
 * One Suspense-wrapped live-check element per record, keyed for `DnsRecords`. Each record
 * resolves and streams in independently — a slow name never holds up the others, or the static
 * record list they sit beside.
 *
 * `missing` carries the record keys the provider hasn't confirmed, so a record that's both
 * missing there and matching live can render as one reconciled state instead of two disagreeing
 * ones (see `LiveRecordCheck`).
 */
export function dnsLiveSlots(records: ProposedDnsRecord[], missing: string[] = []): Record<string, ReactNode> {
  return Object.fromEntries(
    records.map((record) => [
      recordKey(record),
      <Suspense key={recordKey(record)} fallback={<DnsCheckingFallback />}>
        <DnsLiveCheck record={record} providerMissing={missing.includes(recordKey(record))} />
      </Suspense>,
    ]),
  );
}
