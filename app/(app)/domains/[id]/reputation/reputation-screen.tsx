import { brand } from "@/lib/brand";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ThresholdBar, type ThresholdTone } from "@/components/ui/threshold-bar";
import { formatRate, RATE_FLOOR } from "@/lib/metrics/rates";
import { LONG_WINDOW_DAYS, type DomainBlocklists, type DomainReputation, type RecentReason, type ReputationWindow } from "@/lib/reputation/read";
import { BLOCKLIST_INFO, BLOCKLISTS } from "@/lib/blocklists/lists";
import { describeBlocklistStatus } from "@/lib/blocklists/copy";
import { TextLink } from "@/components/ui/text-link";
import {
  BASELINE_DAYS,
  FIRST_TIME_MIN_RECIPIENTS,
  RATE_DIGITS,
  SIGNAL_WINDOW_HOURS,
  type MetricReading,
} from "@/lib/reputation/standing";
import { dayLabel } from "@/lib/format/time";
import type { DomainDetailData, DomainSuppressionSummary } from "@/lib/dashboard/views/domains";
import type { TenantVolume } from "@/lib/providers/adapters/types";
import type { OpenProviderFinding } from "@/lib/reputation/provider-findings";
import { TENANT_VOLUME_DAYS } from "@/lib/providers/provider-metrics";
import { RankedList } from "../../../_ui/ranked-list";
import { SectionHeader } from "../../../_ui/section-header";
import { Term } from "../../../_ui/term";
import { CopyOnHover } from "../../../_ui/copy-on-hover";
import { Time } from "../../../_ui/time";
import { formatNumber } from "@/lib/format/number";
import type { DmarcPanel } from "@/lib/dmarc/read";
import { DmarcReportsCard } from "./dmarc-reports-card";

const METRIC_TITLE = { bounce: "Bounce rate", complaint: "Complaint rate" } as const;

function toneOf(reading: MetricReading): ThresholdTone {
  if (reading.rate === null) return "neutral";
  if (reading.rate >= reading.atRiskLine) return "issue";
  if (reading.rate >= reading.watchLine) return "warn";
  return "good";
}

function WindowRow({ days, reading }: { days: number; reading: MetricReading }) {
  const digits = RATE_DIGITS[reading.metric];
  const previous = reading.previousRate === null ? null : formatRate(reading.previousRate, digits);
  const changed = previous !== null && reading.rate !== null && previous !== formatRate(reading.rate, digits);
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <span className="type-body-sm text-foreground">{days} days</span>
      <span className="flex items-baseline gap-3 font-mono text-sm tabular-nums text-foreground">
        {changed ? (
          <span className={reading.delta !== null && reading.delta > 0 ? "text-danger" : "text-success-ink"}>
            {reading.delta !== null && reading.delta > 0 ? "up" : "down"} from {previous}
          </span>
        ) : null}
        {reading.rate === null ? (
          <span>
            <span className={reading.count === 0 ? "text-muted-foreground" : undefined}>{formatNumber(reading.count)}</span>{" "}
            <span className="text-muted-foreground">of {formatNumber(reading.denominator)}</span>
          </span>
        ) : (
          <span>{formatRate(reading.rate, digits)}</span>
        )}
      </span>
    </div>
  );
}

function MetricCard({ windows, metric }: { windows: ReputationWindow[]; metric: "bounce" | "complaint" }) {
  const [short, ...rest] = windows;
  if (!short) return null;
  const reading = short[metric];
  const digits = RATE_DIGITS[metric];
  const trim = (value: number) => formatRate(value, digits).replace(/\.?0+%$/, "%");
  return (
    <Card className="flex flex-col gap-4 p-5">
      <SectionHeader
        title={METRIC_TITLE[metric]}
        meta={
          reading.rate === null ? (
            <>
              Under {RATE_FLOOR} <Term term="resolved">resolved</Term> messages in {short.days} days, so these are counts.
            </>
          ) : (
            <>
              {formatNumber(reading.denominator)} <Term term="resolved">resolved</Term> messages in {short.days} days.
            </>
          )
        }
      />
      <ThresholdBar
        label={`${METRIC_TITLE[metric]} over ${short.days} days against the pause lines`}
        value={reading.rate}
        tone={toneOf(reading)}
        marks={[
          { value: reading.stallLine, label: `${brand.name} ${trim(reading.stallLine)}` },
          { value: reading.providerReviewLine, label: `Provider review ${trim(reading.providerReviewLine)}` },
          { value: reading.providerPauseLine, label: `Provider pause ${trim(reading.providerPauseLine)}` },
        ]}
      />
      <div className="divide-y divide-border">
        {[short, ...rest].map((window) => (
          <WindowRow key={window.days} days={window.days} reading={window[metric]} />
        ))}
      </div>
    </Card>
  );
}

/** Zero and a dash read quiet, so a value that isn't one stands out. */
function SignalRow({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <span className="min-w-0">
        <span className="type-body-sm block text-foreground">{label}</span>
        <span className="type-body-sm block text-muted-foreground">{help}</span>
      </span>
      <span
        className={`shrink-0 font-mono text-sm tabular-nums ${value === "0" || value === "—" ? "text-muted-foreground" : "text-foreground"}`}
      >
        {value}
      </span>
    </div>
  );
}

const FINDING_TYPE: Record<string, string> = {
  BOUNCE: "Bounces",
  COMPLAINT: "Complaints",
  FEEDBACK_3P: "Mailbox provider feedback",
  IP_LISTING: "Blocklist listing",
};

function findingType(type: string): string {
  return FINDING_TYPE[type] ?? type.charAt(0) + type.slice(1).toLowerCase().replaceAll("_", " ");
}

function ProviderFindings({ findings }: { findings: OpenProviderFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <Card className="p-5">
      <SectionHeader
        title="AWS findings"
        meta="Open findings AWS reports for this organization. They close once AWS sees the cause resolved."
      />
      <ul className="mt-2 divide-y divide-border">
        {findings.map((finding) => (
          <li key={finding.type} className="flex flex-col gap-1 py-2.5">
            <span className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <Chip tone={finding.impact === "HIGH" ? "issue" : "warn"}>{finding.impact === "HIGH" ? "high" : "low"}</Chip>
                <span className="type-body-sm font-semibold text-foreground">{findingType(finding.type)}</span>
              </span>
              <span className="type-body-sm shrink-0 text-muted-foreground">
                Opened <Time date={finding.openedAt} className="font-mono tabular-nums" />
              </span>
            </span>
            {finding.description ? <span className="type-body-sm text-foreground-soft">{finding.description}</span> : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ListRow({ blocklists, list }: { blocklists: DomainBlocklists; list: (typeof BLOCKLISTS)[number] }) {
  const info = BLOCKLIST_INFO[list];
  const check = blocklists.checks.find((row) => row.list === list);
  const listed = check?.status === "listed" && (!check.expiresAt || check.expiresAt > new Date());
  return (
    <li className="flex flex-col gap-1 py-2.5">
      <span className="flex items-center justify-between gap-3">
        <span className="type-body-sm font-semibold text-foreground">{info.label}</span>
        {listed ? (
          <Chip tone={list === "dbl" ? "issue" : "warn"}>listed</Chip>
        ) : (
          <span className="type-body-sm shrink-0 text-muted-foreground">{check?.checkedAt ? "Not listed" : "Not checked"}</span>
        )}
      </span>
      {listed && check ? (
        <span className="type-body-sm text-foreground-soft">
          {capitalize(check.reason ?? "listed")} <span className="font-mono tabular-nums">({check.code})</span>
          {check.listedSince ? <>, since <Time date={check.listedSince} className="font-mono tabular-nums" /></> : null}.{" "}
          {info.removalUrl ? (
            <>
              Fix the cause, then <TextLink href={info.removalUrl}>request removal</TextLink>.
            </>
          ) : (
            "The listing ends 24 hours after Spamhaus first saw the domain."
          )}
        </span>
      ) : null}
      <span className="type-body-sm text-muted-foreground">
        {check?.checkedAt ? (
          <>
            Checked <Time date={check.checkedAt} className="font-mono tabular-nums" />
          </>
        ) : (
          "Checked within a day of the domain verifying."
        )}
        {check?.lastError && check.lastErrorAt ? (
          <>
            {" "}
            · last attempt failed <Time date={check.lastErrorAt} className="font-mono tabular-nums" />
          </>
        ) : null}
      </span>
    </li>
  );
}

function Blocklists({ blocklists }: { blocklists: DomainBlocklists }) {
  const status = describeBlocklistStatus(blocklists.status);
  const hasHistory = blocklists.checks.length > 0 || blocklists.links.length > 0;
  return (
    <Card className="p-5">
      <SectionHeader title="Blocklists" meta={`This domain, and the domains its mail linked to over the last ${SIGNAL_WINDOW_HOURS} hours.`} />
      {blocklists.status.state !== "on" ? (
        <p className="type-body-sm mt-3 flex flex-wrap items-center gap-2 text-foreground-soft">
          <Chip tone={status.tone}>{status.label}</Chip>
          <span>
            {status.text}
            {status.code ? (
              <>
                {" "}
                <code className="font-mono text-sm">{status.code}</code>.
              </>
            ) : null}
          </span>
        </p>
      ) : null}
      {blocklists.status.state === "on" || hasHistory ? (
        <>
          <ul className="mt-2 divide-y divide-border">
            {BLOCKLISTS.map((list) => (
              <ListRow key={list} blocklists={blocklists} list={list} />
            ))}
          </ul>
          <h3 className="type-body-sm mt-4 font-semibold text-foreground">Linked domains</h3>
          {blocklists.links.length === 0 ? (
            <p className="type-body-sm mt-1 text-muted-foreground">No listed links in the last {SIGNAL_WINDOW_HOURS} hours.</p>
          ) : (
            <ul className="mt-1 divide-y divide-border">
              {blocklists.links.map((link) => (
                <li key={`${link.domain}:${link.list}`} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="break-all font-mono text-sm text-foreground">{link.domain}</span>
                    <span className="type-body-sm text-muted-foreground">
                      {BLOCKLIST_INFO[link.list].label}: {link.reason}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
                    {link.messages} {link.messages === 1 ? "message" : "messages"} · <Time date={link.lastSentAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </Card>
  );
}

function TenantCounts({ volume }: { volume: TenantVolume }) {
  return (
    <Card className="p-5">
      <SectionHeader title="As AWS counts it" meta={`Every domain in this organization, over ${TENANT_VOLUME_DAYS} days.`} />
      <div className="mt-2 divide-y divide-border">
        <SignalRow label="Sent" value={formatNumber(volume.sends)} help="Messages AWS accepted." />
        <SignalRow label="Bounced" value={formatNumber(volume.bounces)} help="Messages the receiving server refused." />
        <SignalRow label="Complaints" value={formatNumber(volume.complaints)} help="Recipients who marked a message as spam." />
      </div>
    </Card>
  );
}

const REASON_GROUPS = [
  { status: "bounced", title: "Bounced", tone: "danger" },
  { status: "complained", title: "Complained", tone: "warn" },
] as const;

/** Bars carry color only while the standing needs attention. */
function Reasons({ domainName, reasons, alarmed }: { domainName: string; reasons: RecentReason[]; alarmed: boolean }) {
  return (
    <Card className="p-5">
      <SectionHeader title="Recent reasons" meta={`The receiving server’s words, over ${LONG_WINDOW_DAYS} days.`} />
      {reasons.length === 0 ? (
        <p className="type-body-sm mt-3 text-muted-foreground">No bounces or complaints.</p>
      ) : (
        REASON_GROUPS.map((group) => {
          const rows = reasons.filter((reason) => reason.status === group.status).sort((a, b) => b.count - a.count);
          if (rows.length === 0) return null;
          const href = `/messages?domain=${encodeURIComponent(domainName)}&status=${group.status}&days=${LONG_WINDOW_DAYS}`;
          return (
            <div key={group.status} className="mt-4">
              <h3 className="type-body-sm mb-2 font-semibold text-foreground">{group.title}</h3>
              <RankedList
                tone={alarmed ? group.tone : "neutral"}
                mono
                wrap
                items={rows.map((reason, index) => ({
                  key: `${reason.reason}:${reason.kind ?? ""}:${index}`,
                  label: reason.kind ? (
                    <>
                      <span className="font-sans text-muted-foreground">{reason.kind} · </span>
                      {reason.reason}
                    </>
                  ) : (
                    reason.reason
                  ),
                  title: reason.kind ? `${reason.kind}: ${reason.reason}` : reason.reason,
                  count: reason.count,
                  href,
                }))}
              />
            </div>
          );
        })
      )}
    </Card>
  );
}

/** Suppressions a message from this domain caused. The loader keeps the latest few. */
function Suppressions({ domain, suppressions, zone }: { domain: DomainDetailData; suppressions: DomainSuppressionSummary[]; zone: string }) {
  return (
    <Card className="p-5">
      <SectionHeader
        title="Suppressions from here"
        meta={
          suppressions.length === 0
            ? "No address is suppressed from a message sent here."
            : `The latest ${suppressions.length === 1 ? "address" : `${suppressions.length} addresses`} a message from here got suppressed.`
        }
        actions={
          <TextLink href={`/suppressions?domain=${encodeURIComponent(domain.name)}`}>See all</TextLink>
        }
      />
      {suppressions.length > 0 ? (
        <ul className="mt-2 divide-y divide-border">
          {suppressions.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-3 py-2.5">
              <CopyOnHover value={entry.address} label="address" className="font-mono text-sm text-foreground">
                {entry.address}
              </CopyOnHover>
              <span className="shrink-0 text-2xs text-muted-foreground">{dayLabel(entry.createdAt, zone)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function ReputationSection({
  domain,
  reputation,
  suppressions,
  dmarcReports,
  zone,
}: {
  domain: DomainDetailData;
  /** Null while the organization turned DMARC reports off, or nothing is stored and none are arriving. */
  dmarcReports: DmarcPanel | null;
  /** The viewer's zone, for dates. */
  zone: string;
  /** Null until the domain has verified, when there's nothing to read. */
  reputation: DomainReputation | null;
  suppressions: DomainSuppressionSummary[];
}) {
  if (!reputation) {
    return (
      <Card className="p-5">
        <SectionHeader title="Reputation" />
        <p className="type-body-sm mt-2 text-muted-foreground">
          Bounce and complaint rates, blocklist checks and suppressions show up here once {domain.name} verifies and sends.
        </p>
      </Card>
    );
  }

  const { signals } = reputation;
  const daily = signals ? Math.round(signals.baselineTotal / BASELINE_DAYS) : 0;

  return (
    <>
      <p className="type-body-sm -mt-2 pb-4 text-foreground-soft">
        {brand.name} pauses sending at its own line, before the provider reviews or pauses the sender.
      </p>
      <div className="flex flex-col gap-6">
        {reputation.findings
          .filter((finding) => !(domain.stall && finding.standing === "paused"))
          .map((finding) => (
          <Callout
            key={finding.kind}
            tone={finding.standing === "watch" ? "warn" : "danger"}
            title={finding.title}
          >
            <p>{finding.body}</p>
            <p className="mt-1">{finding.action}</p>
          </Callout>
        ))}

        <div className="grid gap-6 lg:grid-cols-2">
          <MetricCard windows={reputation.windows} metric="bounce" />
          <MetricCard windows={reputation.windows} metric="complaint" />
        </div>

        <ProviderFindings findings={reputation.providerFindings} />

        <Blocklists blocklists={reputation.blocklists} />

        {dmarcReports ? <DmarcReportsCard panel={dmarcReports} /> : null}

        {signals ? (
          <Card className="p-5">
            <SectionHeader title="Sending patterns" meta={`The last ${SIGNAL_WINDOW_HOURS} hours. These can raise a warning, never a pause.`} />
            <div className="mt-2 divide-y divide-border">
              <SignalRow
                label="Volume"
                value={formatNumber(signals.recentTotal)}
                help={
                  signals.baselineTotal > 0
                    ? `Against ${formatNumber(daily)} a day over the previous ${BASELINE_DAYS} days.`
                    : `Nothing sent in the previous ${BASELINE_DAYS} days to compare with.`
                }
              />
              <SignalRow
                label="New recipients"
                value={
                  signals.recentRecipients === 0
                    ? "—"
                    : `${Math.round((signals.firstTimeRecipients / signals.recentRecipients) * 100)}%`
                }
                help={
                  signals.recentRecipients < FIRST_TIME_MIN_RECIPIENTS
                    ? `${formatNumber(signals.recentRecipients)} ${signals.recentRecipients === 1 ? "recipient" : "recipients"}, too few to judge.`
                    : `${formatNumber(signals.firstTimeRecipients)} of ${formatNumber(signals.recentRecipients)} never sent to before.`
                }
              />
              <SignalRow
                label="Refused as suppressed"
                value={formatNumber(signals.suppressedRejections)}
                help="Sends the API turned away because a recipient is suppressed."
              />
            </div>
          </Card>
        ) : null}

        {reputation.tenantVolume ? <TenantCounts volume={reputation.tenantVolume} /> : null}

        <Reasons domainName={reputation.name} reasons={reputation.reasons} alarmed={reputation.standing !== "healthy"} />

        <Suppressions domain={domain} suppressions={suppressions} zone={zone} />
      </div>
    </>
  );
}
