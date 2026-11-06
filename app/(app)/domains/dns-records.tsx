"use client";

import type { ReactNode } from "react";
import { Chip } from "@/components/ui/chip";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { announce } from "@/lib/announce";
import { toast } from "@/lib/toast";
import { StatusDot, sentenceCase, type StatusDotTone } from "@/components/ui/status-dot";
import { recordKey, zoneFile } from "@/lib/dashboard/views/domains";
import type { DnsRecordCheck, DnsVerdict } from "@/lib/dashboard/views/domains";
import { spfMergeGuidance } from "@/lib/domains/spf";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { CopyOnHover } from "../_ui/copy-on-hover";
import { SectionHeader } from "../_ui/section-header";

const VERDICT_LABEL: Record<DnsVerdict, string> = {
  match: "matches",
  different: "different",
  missing: "not found",
  unresolved: "couldn’t check",
};

const VERDICT_TONE: Record<DnsVerdict, StatusDotTone> = {
  match: "good",
  different: "issue",
  missing: "warn",
  unresolved: "neutral",
};

const ERROR_DETAIL: Record<NonNullable<DnsRecordCheck["errorKind"]>, string> = {
  not_found: "Nothing published at this name.",
  timeout: "The DNS lookup timed out, so the record may still be there. Reload to check again.",
  servfail: "The DNS server returned an error, so the record may still be there. Reload to check again.",
  lookup_failed: "The DNS lookup failed, so the record may still be there. Reload to check again.",
};

/**
 * Shows what currently resolves at a record's name, beside what Pouch wants there. Distinct
 * from the confirmed/not-confirmed chip above it, which is the provider's own verification —
 * this is a live, independent DNS read, and a slow or failed lookup reads as "couldn't check"
 * rather than "missing" so the two never get conflated.
 *
 * Two combinations of the provider's verdict and this live read mean something specific enough
 * to say outright, rather than leaving two chips pointing opposite ways for the reader to
 * reconcile:
 *
 * - `providerMissing` with a `match` verdict: published, the provider just hasn't confirmed it
 *   yet. Reassuring — the most common shape right after someone edits DNS.
 * - Provider-confirmed with a `missing` verdict: the provider found this record on its last
 *   check and nothing publishes there now. Something that used to work has been removed or
 *   overwritten since. For a required record that's DKIM about to fail at the provider's next
 *   check, so it reads as an alarm; for an optional one it's worth saying without alarming.
 *
 * Rendered from the server (see `DnsLiveCheck`) and passed in as a resolved element, so it can
 * stay a plain function here without either component needing the other's directive.
 */
export function LiveRecordCheck({ check, providerMissing }: { check: DnsRecordCheck; providerMissing: boolean }) {
  if (providerMissing && check.verdict === "match") {
    return (
      <LiveLine tone="good" label="Published, waiting on the provider">
        This record resolves correctly. The provider hasn&apos;t confirmed it yet.
        {check.record.required ? " Sending is blocked until it does." : null}
      </LiveLine>
    );
  }

  if (!providerMissing && check.verdict === "missing") {
    return (
      <LiveLine tone={check.record.required ? "issue" : "warn"} label="Found, not published now">
        The provider confirmed this record, but nothing publishes at this name now.{" "}
        {check.record.required
          ? "Signing fails at the provider's next check. Publish it again, then verify."
          : "This costs SPF alignment, not delivery."}
      </LiveLine>
    );
  }

  return (
    <LiveLine
      tone={VERDICT_TONE[check.verdict]}
      label={VERDICT_LABEL[check.verdict]}
      found={check.verdict === "different" ? check.observed : undefined}
      foundLabel={`${check.record.type} value found`}
    >
      {check.verdict === "missing" || check.verdict === "unresolved"
        ? check.verdict === "missing"
          ? ERROR_DETAIL.not_found
          : ERROR_DETAIL[check.errorKind ?? "lookup_failed"]
        : null}
    </LiveLine>
  );
}

/** What resolves at the name right now: a dot and label, then what was found or why not. */
function LiveLine({
  tone,
  label,
  found,
  foundLabel = "value found",
  children,
}: {
  tone: StatusDotTone;
  label: string;
  found?: string[];
  foundLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="type-body-sm text-muted-foreground">Live DNS</span>
        <StatusDot tone={tone}>{sentenceCase(label)}</StatusDot>
      </div>
      {found?.map((value) => (
        <CopyOnHover key={value} value={value} label={foundLabel} className="font-mono text-sm text-foreground-soft" wrap>
          {value}
        </CopyOnHover>
      ))}
      {children ? <p className="type-body-sm text-muted-foreground">{children}</p> : null}
    </div>
  );
}

/** What a record's live-check slot shows before the lookup answers. */
export function DnsCheckingFallback() {
  return <p className="type-body-sm text-muted-foreground">Checking live DNS…</p>;
}

function CopyZoneFile({ value }: { value: string }) {
  const { copied, copy } = useCopyToClipboard();
  async function handleClick() {
    if (await copy(value)) announce("Zone file copied");
    else toast({ title: "Couldn’t copy the zone file", description: "Your browser blocked the clipboard.", variant: "error" });
  }
  return (
    <Button type="button" variant="secondary" size="sm" onClick={handleClick}>
      {copied ? "Copied" : "Copy as zone file"}
    </Button>
  );
}

/**
 * One row per record with its own found or missing state from the last answered check,
 * a copy button per name and value and copy-all.
 *
 * `liveSlots`, when given, adds what currently resolves at each record's name. Each slot is a
 * `<Suspense>`-wrapped server component the caller builds and passes in already rendered — this
 * component only places it, so the DNS lookup behind it can stream in after the record list
 * itself has painted rather than gate it.
 */
export function DnsRecords({
  records,
  missing,
  checked,
  liveSlots,
  title = "DNS records",
  description,
  actions,
}: {
  records: ProposedDnsRecord[];
  /** Record keys the last check couldn't see. */
  missing: string[];
  /** False before any check has answered, when found and missing are both unknown. */
  checked: boolean;
  /** A live-check element per record, keyed by matching `recordKey`. Omit to skip the section. */
  liveSlots?: Record<string, ReactNode>;
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  const confirmed = records.length - missing.length;

  return (
    <section className="flex flex-col gap-2">
      <SectionHeader
        title={title}
        description={description}
        meta={
          records.length === 0
            ? undefined
            : checked
            ? `${confirmed} of ${records.length} records confirmed by the provider.`
            : `${records.length} records to publish.`
        }
        actions={
          <>
            {records.length > 0 ? <CopyZoneFile value={zoneFile(records)} /> : null}
            {actions}
          </>
        }
      />

      {records.length === 0 ? (
        <p className="type-body-sm text-muted-foreground">
          The provider returned no records. Copy them from its dashboard.
        </p>
      ) : null}

      <ul className="flex flex-col divide-y divide-border">
        {records.map((record) => {
          const ok = !missing.includes(recordKey(record));
          const merge = record.merge === "spf" ? spfMergeGuidance(record) : null;
          const value = record.priority ? `${record.priority} ${record.value}` : record.value;
          return (
            <li key={recordKey(record)} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Chip tone="value">{record.type}</Chip>
                {/* The name wraps rather than truncates: it's what gets typed into the zone. */}
                <CopyOnHover
                  value={record.name}
                  label={`${record.type} name`}
                  className="order-last basis-full font-mono text-sm text-foreground sm:order-none sm:basis-auto sm:flex-1"
                  wrap
                  always
                >
                  {record.name}
                </CopyOnHover>
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  {merge ? <Chip tone="warn">merge</Chip> : null}
                  {record.required ? null : <Chip tone="neutral">optional</Chip>}
                  {checked ? (
                    <StatusDot tone={ok ? "good" : record.required ? "warn" : "neutral"}>
                      {ok ? "Confirmed" : "Not confirmed"}
                    </StatusDot>
                  ) : null}
                </span>
              </div>
              <CopyOnHover value={value} label={`${record.type} value`} className="font-mono text-sm text-foreground-soft" wrap always>
                {value}
              </CopyOnHover>
              {merge ? (
                <div className="flex flex-col gap-1">
                  <p className="type-body-sm text-foreground-soft">{merge.note}</p>
                  <CopyOnHover value={merge.mechanisms} label="SPF mechanism" className="font-mono text-sm text-foreground" wrap always>
                    {merge.mechanisms}
                  </CopyOnHover>
                  {merge.cost ? <p className="type-body-sm text-muted-foreground">{merge.cost}</p> : null}
                </div>
              ) : null}
              {liveSlots?.[recordKey(record)] ?? null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
