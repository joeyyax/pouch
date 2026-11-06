import type { ReactNode } from "react";
import { Chip } from "@/components/ui/chip";
import { StatusDot, StatusMark, type StatusDotTone } from "@/components/ui/status-dot";
import { dmarcName, type DmarcFinding, type DmarcStatus, type IdentityAlignment, type SerializedDmarc } from "@/lib/domains/dmarc";
import { CopyOnHover } from "../_ui/copy-on-hover";
import { SectionHeader } from "../_ui/section-header";

const STATUS_LABEL: Record<DmarcStatus, string> = {
  found: "Published",
  missing: "Not published",
  multiple: "More than one record",
  invalid: "Can’t be read",
  unresolved: "Couldn’t check",
};

const STATUS_TONE: Record<DmarcStatus, StatusDotTone> = {
  found: "good",
  missing: "warn",
  multiple: "issue",
  invalid: "issue",
  unresolved: "neutral",
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="type-body-sm w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="type-body-sm min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

function alignmentLine(label: string, identity: IdentityAlignment): ReactNode {
  if (identity.domains.length === 0) return `No ${label} record to check.`;
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <StatusDot tone={identity.aligned ? "good" : "neutral"}>{identity.aligned ? "Aligned" : "Not aligned"}</StatusDot>
      <span className="font-mono text-sm text-foreground-soft [overflow-wrap:anywhere]">{identity.domains.join(", ")}</span>
      <span className="text-muted-foreground">{identity.mode}</span>
    </span>
  );
}

function Finding({ finding }: { finding: DmarcFinding }) {
  return (
    <li className="flex items-start gap-2">
      <StatusMark tone={finding.severity === "problem" ? "warn" : "neutral"} />
      <span className="type-body-sm min-w-0 flex-1 text-foreground-soft">
        <span className="sr-only">{finding.severity === "problem" ? "Needs a change: " : "Note: "}</span>
        {finding.message}
      </span>
    </li>
  );
}

/** A `_dmarc` TXT record to publish, name and value each copyable, with one line on what it does. */
export function DmarcRecordToPublish({ name, value, note, optional = true }: { name: string; value: string; note: string; optional?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Chip tone="value">TXT</Chip>
        <CopyOnHover value={name} label="TXT name" className="order-last basis-full font-mono text-sm text-foreground sm:order-none sm:basis-auto sm:flex-1" wrap always>
          {name}
        </CopyOnHover>
        {optional ? <Chip tone="neutral">optional</Chip> : null}
      </div>
      <CopyOnHover value={value} label="TXT value" className="font-mono text-sm text-foreground-soft" wrap always>
        {value}
      </CopyOnHover>
      <p className="type-body-sm text-muted-foreground">{note}</p>
    </div>
  );
}

/** The record to publish: the recommended one, or the published one with the report address added. */
function Recommended({ domainName, value, merged }: { domainName: string; value: string; merged: boolean }) {
  return (
    <DmarcRecordToPublish
      name={dmarcName(domainName)}
      value={value}
      note={merged ? "Replace the published record with this one. It keeps every tag and adds the report address." : "p=none watches and changes nothing about delivery."}
    />
  );
}

/** What the domain's DMARC record says, with the record to publish when there isn't a usable one. */
export function DmarcCard({ domainName, dmarc }: { domainName: string; dmarc: SerializedDmarc }) {
  const found = dmarc.status === "found";
  const governing = dmarc.source === "organizational" ? (dmarc.subdomain_policy ?? dmarc.policy) : dmarc.policy;

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="DMARC"
        meta={
          found && dmarc.record_name
            ? dmarc.source === "organizational"
              ? `Read from ${dmarc.record_name}, this domain’s organizational domain.`
              : `Read from ${dmarc.record_name}.`
            : undefined
        }
        actions={<StatusDot tone={STATUS_TONE[dmarc.status]}>{STATUS_LABEL[dmarc.status]}</StatusDot>}
      />

      {found ? (
        <dl className="flex flex-col gap-2">
          <Row label="Policy">
            <span className="font-mono text-sm">p={dmarc.policy}</span>
            {dmarc.subdomain_policy ? <span className="font-mono text-sm text-foreground-soft"> · sp={dmarc.subdomain_policy}</span> : null}
            {dmarc.percent !== null && dmarc.percent < 100 ? <span className="text-muted-foreground"> · applies to {dmarc.percent}% of mail</span> : null}
            {governing !== dmarc.policy ? <span className="text-muted-foreground"> · this domain follows sp</span> : null}
          </Row>
          <Row label="Reports">
            {dmarc.rua.length > 0 ? (
              <span className="flex flex-col gap-0.5">
                {dmarc.rua.map((uri) => (
                  <span key={uri} className="font-mono text-sm [overflow-wrap:anywhere]">
                    {uri}
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground">No report address.</span>
            )}
            {dmarc.ruf.length > 0 ? <span className="mt-0.5 block font-mono text-sm text-foreground-soft [overflow-wrap:anywhere]">failures: {dmarc.ruf.join(", ")}</span> : null}
          </Row>
          {dmarc.alignment ? (
            <>
              <Row label="DKIM">{alignmentLine("DKIM", dmarc.alignment.dkim)}</Row>
              <Row label="SPF">{alignmentLine("SPF", dmarc.alignment.spf)}</Row>
            </>
          ) : null}
        </dl>
      ) : null}

      {dmarc.findings.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {dmarc.findings.map((finding) => (
            <Finding key={finding.kind} finding={finding} />
          ))}
        </ul>
      ) : null}

      {dmarc.recommended ? <Recommended domainName={domainName} value={dmarc.recommended} merged={found} /> : null}
    </section>
  );
}
