"use client";

import Link from "next/link";
import { BarChart } from "@/components/ui/chart";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Stat } from "@/components/ui/stat";
import { formatDuration } from "@/lib/metrics/duration";
import {
  deltaTone,
  formatRate,
  formatRateDelta,
  rateDelta,
  rateFor,
  resolved,
  RATE_FLOOR,
  type Outcome,
} from "@/lib/metrics/rates";
import { LiveIndicator } from "./messages/live-indicator";
import { useLiveUpdates } from "./messages/use-live-updates";
import { bucketUnit, METRICS_WINDOWS, windowLabel, type MetricsWindowDays } from "@/lib/metrics/window";
import type { DomainMetrics, MetricsOverview, VolumeDay } from "@/lib/dashboard/views/metrics";
import type { StallLines } from "@/lib/domains/guard";
import { WATCH_SHARE, type Standing } from "@/lib/reputation/standing";
import type { SetupStep } from "@/lib/dashboard/views/setup";
import { Conditions } from "./_overview/conditions";
import { LatencyBars } from "./_overview/latency-bars";
import { QueueFlow } from "./_overview/queue-flow";
import { SetupChecklist } from "./_overview/setup-checklist";
import { PageHeader } from "./_ui/page-header";
import { RankedList } from "./_ui/ranked-list";
import { SectionHeader } from "./_ui/section-header";
import { SegmentedLinks } from "./_ui/segmented-links";
import { Sparkline } from "./_ui/sparkline";
import { StandingChip, standingNote } from "./_ui/status";
import { Term } from "./_ui/term";
import { Time } from "./_ui/time";
import { UnassignedAlert } from "./_ui/unassigned-alert";
import { formatNumber } from "@/lib/format/number";
import type { SnippetLanguage } from "@/lib/dashboard/curl";

const OUTCOME_LABEL: Record<Outcome, string> = {
  delivered: "Delivered",
  bounced: "Bounced",
  complained: "Complained",
  failed: "Failed",
};

/** Delivered leads because it's the one that should be large. The rest are exceptions. */
const RATE_ORDER: Outcome[] = ["delivered", "bounced", "complained", "failed"];

const NEUTRAL = "var(--muted-foreground)";

/** Delivered is good news, so green. The exceptions stay gray until they cross a line worth a look. */
const OUTCOME_COLOR: Record<Outcome, string> = {
  delivered: "var(--success)",
  bounced: "var(--danger)",
  complained: "var(--warning)",
  failed: "var(--danger)",
};

/** One failed send in a hundred. */
const FAILED_ATTENTION_RATE = 0.01;

function needsAttention(outcome: Outcome, rate: number | null, count: number, lines: StallLines): boolean {
  if (outcome === "delivered") return true;
  if (rate === null) {
    if (outcome === "bounced") return count >= lines.bounce.count;
    if (outcome === "complained") return count >= lines.complaint.count;
    return count > 0;
  }
  if (outcome === "bounced") return rate >= lines.bounce.stall * WATCH_SHARE;
  if (outcome === "complained") return rate >= lines.complaint.stall * WATCH_SHARE;
  return rate >= FAILED_ATTENTION_RATE;
}

function dayLabels(volume: VolumeDay[]): string[] {
  return volume.map((day) => day.label);
}

const accepted = (day: VolumeDay) => day.delivered + day.bounced + day.complained + day.failed + day.pending;

const count = (value: number, one: string, many: string) => `${formatNumber(value)} ${value === 1 ? one : many}`;

/** What complained and failed mean, told with this window's numbers. */
function outcomeNote(outcome: Outcome, counts: MetricsOverview["counts"], days: MetricsWindowDays): string | null {
  if (outcome === "complained") {
    return counts.complained === 0
      ? `No recipient marked a message as spam in ${windowLabel(days)}. A complaint suppresses the address.`
      : `${count(counts.complained, "message", "messages")} marked as spam in ${windowLabel(days)}. Each recipient is now suppressed.`;
  }
  if (outcome === "failed") {
    return counts.failed === 0
      ? `Nothing failed in ${windowLabel(days)}. A message fails when the provider refuses it or retries run out.`
      : `${count(counts.failed, "message", "messages")} couldn't be sent in ${windowLabel(days)}: the provider refused them or retries ran out.`;
  }
  return null;
}

function deltaNote(outcome: Outcome, delta: number, previous: number, days: MetricsWindowDays): string {
  const points = Math.abs(delta * 100).toFixed(1);
  const before = formatRate(previous, outcome === "complained" ? 2 : 1);
  return `${delta > 0 ? "Up" : "Down"} ${points} percentage points from ${before} the previous ${windowLabel(days)}.`;
}

function RateStat({ overview, outcome }: { overview: MetricsOverview; outcome: Outcome }) {
  const current = rateFor(overview.counts, outcome);
  const previous = rateFor(overview.previousCounts, outcome);
  const delta = rateDelta(current, previous);
  const mark = formatRateDelta(delta);
  const note = outcomeNote(outcome, overview.counts, overview.days);
  const label = note ? (
    <Term definition={note}>{OUTCOME_LABEL[outcome]}</Term>
  ) : (
    OUTCOME_LABEL[outcome]
  );
  const trend = (
    <Sparkline
      className="mt-3"
      values={overview.volume.map((day) => day[outcome])}
      previous={overview.previousVolume.map((day) => day[outcome])}
      labels={dayLabels(overview.volume)}
      previousLabels={dayLabels(overview.previousVolume)}
      color={needsAttention(outcome, current, overview.counts[outcome], overview.reputation.lines) ? OUTCOME_COLOR[outcome] : NEUTRAL}
      label={`${OUTCOME_LABEL[outcome]} per ${bucketUnit(overview.days)}`}
    />
  );

  // Below the floor a percentage is noise, so the count stands in.
  if (current === null) {
    return (
      <div>
        <Stat value={overview.counts[outcome]} label={label} />
        {trend}
      </div>
    );
  }

  return (
    <div>
      <Stat
        value={current * 100}
        suffix="%"
        format={{ maximumFractionDigits: 1, minimumFractionDigits: 1 }}
        label={label}
        delta={
          mark && delta !== null && previous !== null ? (
            <Term definition={deltaNote(outcome, delta, previous, overview.days)} className="leading-none">
              {mark}
            </Term>
          ) : undefined
        }
        deltaTone={deltaTone(outcome, delta)}
        deltaLabel={mark ? `versus the previous ${windowLabel(overview.days)}` : undefined}
      />
      {trend}
    </div>
  );
}

function domainColumns(standing: (domainId: string) => Standing, days: MetricsWindowDays): DataTableColumn<DomainMetrics>[] {
  return [
    {
      key: "domain",
      header: "Domain",
      priority: "primary",
      cellClassName: "w-full max-w-0",
      cell: (row) => (
        <span className="flex items-center gap-2">
          <Link
            href={`/messages?domain=${encodeURIComponent(row.domainName)}`}
            className="font-medium underline underline-offset-4 hover:no-underline"
          >
            {row.domainName}
          </Link>
          {standing(row.domainId) === "healthy" ? null : <StandingChip standing={standing(row.domainId)} explain />}
        </span>
      ),
    },
    {
      key: "trend",
      header: "Trend",
      priority: "detail",
      cellClassName: "w-28",
      cell: (row) => (
        <Sparkline values={row.daily} label={`${row.domainName} messages per ${bucketUnit(days)}`} interactive={false} className="h-6 w-24" />
      ),
    },
    {
      key: "total",
      header: "Messages",
      numeric: true,
      priority: "primary",
      cell: (row) =>
        row.counts.total === 0 ? (
          <Chip tone="warn">Stopped</Chip>
        ) : (
          <span className="tabular-nums">{formatNumber(row.counts.total)}</span>
        ),
    },
    {
      key: "delivered",
      header: "Delivered",
      numeric: true,
      cell: (row) => <span className="tabular-nums">{formatRate(rateFor(row.counts, "delivered"))}</span>,
    },
    {
      key: "bounced",
      header: "Bounced",
      numeric: true,
      cell: (row) => <span className="tabular-nums">{formatRate(rateFor(row.counts, "bounced"))}</span>,
    },
    {
      key: "complained",
      header: <Term term="complained">Complained</Term>,
      numeric: true,
      priority: "detail",
      cell: (row) => <span className="tabular-nums">{formatRate(rateFor(row.counts, "complained"), 2)}</span>,
    },
    {
      key: "queue",
      header: <Term term="queue_p95">Queue p95</Term>,
      numeric: true,
      priority: "detail",
      cell: (row) => <span className="tabular-nums">{formatDuration(row.queueP95)}</span>,
    },
    {
      key: "last",
      header: "Last send",
      numeric: true,
      cellClassName: "whitespace-nowrap",
      cell: (row) => (row.lastSentAt ? <Time date={row.lastSentAt} /> : <span className="text-muted-foreground">Never</span>),
    },
  ];
}

/** Why, then a way there: one domain needing a look goes to its reputation, several to the list. */
function StandingStatus({ reputation }: { reputation: MetricsOverview["reputation"] }) {
  const [only, ...rest] = reputation.attention;
  const href = only && rest.length === 0 ? `/domains/${only.id}/reputation` : "/domains";
  return (
    <StandingChip
      standing={reputation.standing}
      explain={
        <>
          {standingNote(reputation.standing, reputation.reason)}{" "}
          {reputation.standing === "healthy" ? null : (
            <Link href={href} className="whitespace-nowrap underline underline-offset-4 hover:no-underline">
              {only && rest.length === 0 ? "See reputation" : "See domains"}
            </Link>
          )}
        </>
      }
    />
  );
}

function LastSendMeta({ at, days }: { at: Date | null; days: MetricsWindowDays }) {
  if (!at) return <>No sends in {windowLabel(days)}.</>;
  return (
    <>
      Last send <Time date={at} />.
    </>
  );
}

function lastSend(domains: DomainMetrics[]): Date | null {
  let latest: Date | null = null;
  for (const domain of domains) {
    if (domain.lastSentAt && (!latest || domain.lastSentAt > latest)) latest = domain.lastSentAt;
  }
  return latest;
}

/** The 24-hour view refreshes on sends, at most this often. Longer windows don't refresh. */
const LIVE_REFRESH_MS = 10_000;

export function OverviewScreen({
  overview,
  assigned,
  setup,
  canManage = false,
}: {
  overview: MetricsOverview;
  assigned: boolean;
  /** Whether the viewer may mute or turn off an observation. */
  canManage?: boolean;
  /** Null once a live message has sent. */
  setup: { steps: SetupStep[]; sendSnippets: SnippetLanguage[] | null } | null;
}) {
  const { counts, queue, days } = overview;
  const settled = resolved(counts);
  const standings = new Map(overview.reputation.attention.map((domain) => [domain.id, domain.standing]));
  const retriesRaised = overview.conditions.some((condition) => condition.key === "retry_pressure");
  const live = useLiveUpdates({ enabled: days === 1, minIntervalMs: LIVE_REFRESH_MS });

  return (
    <>
      <PageHeader
        title="Overview"
        status={overview.everSentLive ? <StandingStatus reputation={overview.reputation} /> : undefined}
        meta={
          overview.everSentLive ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <LastSendMeta at={lastSend(overview.domains)} days={days} />
              {days === 1 ? <LiveIndicator state={live} /> : null}
            </span>
          ) : undefined
        }
        actions={
          overview.everSentLive ? (
            <SegmentedLinks
              label="Window"
              mono
              options={METRICS_WINDOWS.map((option) => ({
                href: option === 30 ? "/" : `/?days=${option}`,
                label: option === 1 ? "24h" : `${option}d`,
                active: option === days,
              }))}
            />
          ) : undefined
        }
      />

      {assigned ? null : <UnassignedAlert className="mb-6" />}

      {setup ? (
        <SetupChecklist steps={setup.steps} sendSnippets={setup.sendSnippets} />
      ) : (
        <div className="flex flex-col gap-6">
          <Conditions conditions={overview.conditions} canManage={canManage} />

          <Card className="p-6">
            <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
              <div>
                <Stat value={counts.total} label={`Messages in ${windowLabel(days)}`} />
                <Sparkline
                  className="mt-3"
                  values={overview.volume.map(accepted)}
                  previous={overview.previousVolume.map(accepted)}
                  labels={dayLabels(overview.volume)}
                  previousLabels={dayLabels(overview.previousVolume)}
                  label={`Messages per ${bucketUnit(overview.days)}`}
                />
              </div>
              {RATE_ORDER.map((outcome) => (
                <RateStat key={outcome} overview={overview} outcome={outcome} />
              ))}
            </div>
            <p className="mt-6 type-body-sm text-muted-foreground">
              {settled < RATE_FLOOR
                ? `Counts until ${RATE_FLOOR} messages resolve, then rates. Faint lines are the previous ${windowLabel(days)}.`
                : (
                  <>
                    Rates across {formatNumber(settled)} <Term term="resolved">resolved</Term> messages. Changes and
                    faint lines compare with the previous {windowLabel(days)}.
                  </>
                )}
              {counts.inFlight > 0 ? ` ${formatNumber(counts.inFlight)} still waiting on the provider.` : null}
            </p>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="p-6">
              <SectionHeader title="Delivery time" description="How long a send takes at each stage." />
              <div className="mt-4">
                <LatencyBars
                  stages={[
                    { label: "Queued", help: "From the API to the provider.", span: "to reach the provider", latency: overview.queueLatency },
                    { label: "At the provider", help: "From the provider to the receiving server.", span: "from the provider to delivery", latency: overview.providerLatency },
                    { label: "End to end", help: "From the API to the receiving server.", span: "from the API to delivery", latency: overview.endToEndLatency },
                  ]}
                />
              </div>
            </Card>

            <Card className="p-6">
              <SectionHeader title="Queue" description="Where queued mail is right now." />
              <div className="mt-4">
                <QueueFlow queue={queue} />
              </div>
              {retriesRaised || queue.retryPressure === 0 ? null : (
                <p className="mt-2 type-body-sm text-muted-foreground">
                  {queue.retryPressure.toFixed(2)} attempts per message
                  {queue.previousRetryPressure === 0 ? "." : `, ${queue.previousRetryPressure.toFixed(2)} the previous ${windowLabel(days)}.`}
                </p>
              )}
            </Card>
          </div>

          <Card className="p-6">
            <SectionHeader title="Volume" meta={`Messages per ${bucketUnit(days)}.`} />
            <BarChart
              className="mt-4"
              title={`Messages per ${bucketUnit(days)} over ${windowLabel(days)}`}
              summary={`${formatNumber(counts.total)} messages in the last ${windowLabel(days)}.`}
              data={overview.volume.map((day) => ({
                name: day.label,
                delivered: day.delivered,
                pending: day.pending,
                bounced: day.bounced,
                complained: day.complained,
                failed: day.failed,
              }))}
              stacked
              dense={days > 30}
              height={220}
              series={[
                { key: "delivered", label: "Delivered", color: "var(--success)" },
                { key: "pending", label: "In flight", color: "var(--muted-foreground)" },
                { key: "bounced", label: "Bounced", color: "var(--danger)" },
                { key: "complained", label: "Complained", color: "var(--warning)" },
                { key: "failed", label: "Failed", color: "var(--danger-soft)" },
              ]}
            />
          </Card>

          <Card className="overflow-hidden p-0">
            <div className="px-6 pt-6">
              <SectionHeader title="By domain" description="Each domain keeps its own reputation." />
            </div>
            <DataTable
              label="Metrics by domain"
              className="mt-4"
              columns={domainColumns((domainId) => standings.get(domainId) ?? "healthy", days)}
              rows={overview.domains}
              getRowKey={(row) => row.domainId}
              empty={
                <EmptyState
                  icon="globe"
                  title="No sends in this window"
                  description="Widen the window, or send a message."
                />
              }
            />
          </Card>

          {overview.bounceReasons.length > 0 ? (
            <Card className="p-6">
              <SectionHeader title="Bounce reasons" description="What receiving servers said, word for word." />
              <div className="mt-4">
                <RankedList
                  mono
                  items={overview.bounceReasons.map((reason) => ({
                    key: reason.reason,
                    label: reason.reason,
                    title: reason.reason,
                    count: reason.count,
                    href: reason.href,
                  }))}
                />
              </div>
            </Card>
          ) : null}

          <p className="type-body-sm text-muted-foreground">
            Opens and clicks aren&apos;t tracked.
          </p>
        </div>
      )}
    </>
  );
}
