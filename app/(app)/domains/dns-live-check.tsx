import { checkRecord } from "@/lib/domains/dns-check";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { LiveRecordCheck } from "./dns-records";

/**
 * Resolves one record's live DNS state and renders it. A server component so the lookup runs on
 * the server; rendered inside a `<Suspense>` boundary by its caller so the record list around it
 * never waits on this to paint.
 *
 * `providerMissing` says whether the provider still has this record in `missing_records` — passed
 * through so a live `match` on a provider-missing record renders as one state, not two.
 */
export async function DnsLiveCheck({ record, providerMissing }: { record: ProposedDnsRecord; providerMissing: boolean }) {
  const check = await checkRecord(record);
  return <LiveRecordCheck check={check} providerMissing={providerMissing} />;
}
