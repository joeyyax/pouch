import { Alert } from "@/components/ui/alert";
import { brand } from "@/lib/brand";
import { Card } from "@/components/ui/card";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { spellDuration } from "@/lib/metrics/duration";
import { adapterLabel, RATE_WINDOW_DAYS } from "@/lib/dashboard/views/domains";
import { groupLoops, healthyLoopsLabel, UNCONFIRMED_WINDOW_MS } from "@/lib/system/views";
import type { ServiceHealth, WorkerState } from "@/lib/dashboard/views/service";
import type { LoopLivenessView, OrganizationQueueView, ProviderIdentityGroupView, StuckLockView, UnconfirmedClusterView } from "@/lib/system/views";
import { formatRate, outcomeCounts, rate, resolved } from "@/lib/metrics/rates";
import { ThresholdBar, type ThresholdTone } from "@/components/ui/threshold-bar";
import type { ReactNode } from "react";
import { QUOTA_WARN_SHARE, quotaShare } from "@/lib/providers/quota";
import type { QuotaReading, RatesReading } from "@/lib/providers/provider-metrics";
import type { BodyLifecycleView, ProviderMetricsView } from "@/lib/system/read";
import type { StallLines, StallMetric } from "@/lib/domains/guard";
import { AT_RISK_SHARE, RATE_DIGITS, WATCH_SHARE } from "@/lib/reputation/standing";
import type { ActivityListItem } from "@/lib/activity/types";
import { TextLink } from "@/components/ui/text-link";
import { RankedList } from "../../../_ui/ranked-list";
import { SectionHeader } from "../../../_ui/section-header";
import { HealthyLoops } from "./_ui/healthy-loops";
import { LoopRow } from "./_ui/loop-row";
import { ServiceActivityRow } from "./_ui/service-activity-row";
import { Time } from "../../../_ui/time";
import { formatNumber } from "@/lib/format/number";

const WORKER_TONE: Record<WorkerState, ChipTone> = { healthy: "good", silent: "issue", unknown: "neutral" };

const WORKER_LINE: Record<WorkerState, string | null> = {
  healthy: null,
  silent: "No worker has reported in. Queued mail isn\u2019t going out in any organization.",
  unknown: "Redis isn\u2019t configured, so worker heartbeats can\u2019t be read.",
};

const LIFECYCLE_TONE: Record<BodyLifecycleView["status"], ChipTone> = { ok: "good", degraded: "issue", unknown: "neutral" };

const LIFECYCLE_COPY = {
  bodies: {
    title: "Body storage",
    noun: "bodies",
    description: "The bucket\u2019s lifecycle rule against the retention ceiling.",
    none: "No lifecycle rule on the bucket expires bodies, so their objects stay after their keys go.",
    degraded: "The rule expires bodies at or under the ceiling, so bodies can go before their keys do.",
  },
  inbound: {
    title: "Inbound storage",
    noun: "inbound mail",
    description: "The bucket\u2019s lifecycle rule against the inbound retention ceiling.",
    none: null,
    degraded: "The rule expires inbound mail at or under the ceiling, so mail can go before its retention ends.",
  },
} as const;

/** The bucket's rule has to outlast the retention ceiling, or it deletes objects whose rows still exist. */
function BucketLifecycle({ view, kind }: { view: BodyLifecycleView; kind: keyof typeof LIFECYCLE_COPY }) {
  const copy = LIFECYCLE_COPY[kind];
  const line =
    view.status === "unknown"
      ? `${brand.name} can\u2019t read the bucket\u2019s lifecycle rule. Make sure it expires ${copy.noun} after more than ${view.ceiling} days.`
      : view.expiryDays === null
        ? copy.none
        : view.status === "degraded"
          ? `${copy.degraded} Move it past ${view.ceiling} days.`
          : null;
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title={copy.title} description={copy.description} />
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Chip tone={LIFECYCLE_TONE[view.status]}>{view.status}</Chip>
          <span className="type-body-sm text-foreground-soft">
            Ceiling {view.ceiling} days · bucket rule {view.expiryDays === null ? (view.status === "unknown" ? "unknown" : "none") : `${view.expiryDays} days`}
          </span>
        </div>
        {line ? <p className="type-body-sm mt-3 text-foreground-soft">{line}</p> : null}
      </Card>
    </section>
  );
}

/** The fleet, then the loops it runs. A loop can be dead while the fleet reports in, so both. */
function WorkerFleet({ health }: { health: ServiceHealth }) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={WORKER_TONE[health.worker]}>{health.worker}</Chip>
        <span className="type-body-sm text-muted-foreground">
          {health.workers.length} {health.workers.length === 1 ? "worker" : "workers"} reporting in
        </span>
      </div>
      {health.workers.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
          {health.workers.map((worker) => (
            <li key={worker.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">{worker.id}</span>
              <Time date={worker.lastBeatAt} className="shrink-0 text-muted-foreground" />
            </li>
          ))}
        </ul>
      ) : null}
      {WORKER_LINE[health.worker] ? (
        <p className="type-body-sm mt-3 text-foreground-soft">{WORKER_LINE[health.worker]}</p>
      ) : null}
    </Card>
  );
}

function LoopLiveness({ health, loops }: { health: ServiceHealth; loops: LoopLivenessView[] }) {
  const { attention, healthy } = groupLoops(loops);
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Worker loops"
        description="Each row is the last run across the fleet. Silent means a loop missed its own window; failing means its last run threw."
      />
      <WorkerFleet health={health} />
      <Card className="overflow-hidden p-0">
        {attention.length > 0 ? (
          <ul>
            {attention.map((loop) => (
              <LoopRow key={loop.loop} loop={loop} />
            ))}
          </ul>
        ) : null}
        {healthy.length > 0 ? (
          <HealthyLoops label={healthyLoopsLabel(healthy.length, attention.length > 0)} bordered={attention.length > 0}>
            {healthy.map((loop) => (
              <LoopRow key={loop.loop} loop={loop} />
            ))}
          </HealthyLoops>
        ) : null}
      </Card>
    </section>
  );
}

function StuckLocks({ locks }: { locks: StuckLockView[] }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Stuck locks"
        description="Rows locked past their lease by a worker that died. They don't clear on their own."
        meta={locks.length > 0 ? `${locks.length} ${locks.length === 1 ? "row" : "rows"}` : undefined}
      />
      <Card className="overflow-hidden p-0">
        {locks.length === 0 ? (
          <p className="type-body-sm p-5 text-muted-foreground">No rows locked past their lease.</p>
        ) : (
          <ul>
            {locks.map((lock) => (
              <li
                key={lock.messageId}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm text-foreground">{lock.messageId}</p>
                  <p className="type-body-sm text-muted-foreground">
                    {lock.organizationName} · locked by <span className="font-mono">{lock.lockedBy}</span>
                  </p>
                </div>
                <Time date={lock.lockedAt} className="shrink-0 text-muted-foreground" />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

function QueueByOrganization({ organizations }: { organizations: OrganizationQueueView[] }) {
  const total = organizations.reduce((sum, org) => sum + org.depth, 0);
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Queue by organization"
        description="A queue that isn't draining is usually one caller retrying."
        meta={total > 0 ? `${formatNumber(total)} ${total === 1 ? "message" : "messages"} queued` : undefined}
      />
      <Card className={organizations.length === 0 ? "p-5" : "p-3"}>
        {organizations.length === 0 ? (
          <p className="type-body-sm text-muted-foreground">Nothing queued in any organization.</p>
        ) : (
          <RankedList
            items={organizations.map((org) => ({
              key: org.organizationId ?? "service",
              title: org.organizationName,
              count: org.depth,
              label: (
                <>
                  {org.organizationName}
                  {org.oldestQueuedAt ? (
                    <span className="text-muted-foreground">
                      {" \u00b7 oldest "}
                      <Time date={org.oldestQueuedAt} />
                    </span>
                  ) : null}
                </>
              ),
            }))}
          />
        )}
      </Card>
    </section>
  );
}

function UnconfirmedCluster({ view, sweeping }: { view: UnconfirmedClusterView; sweeping: boolean }) {
  const marks = `${formatNumber(view.marked)} ${view.marked === 1 ? "message" : "messages"}`;
  return (
    // The push alert links here.
    <section id="unconfirmed-sends" className="flex scroll-mt-6 flex-col gap-3">
      <SectionHeader
        title="Unconfirmed sends"
        description={`Sends with no delivery event in the last ${spellDuration(UNCONFIRMED_WINDOW_MS)}. A cluster means event ingest is dropping them.`}
        meta={sweeping ? `${formatRate(view.share)} of ${formatNumber(view.eligibleSends)} sends` : undefined}
      />
      {sweeping ? null : (
        <Alert tone="warn" title="Nothing is marking messages unconfirmed">
          The marking loop isn&rsquo;t running, so these counts mean nothing. Check Worker loops.
        </Alert>
      )}
      {sweeping && view.clustered ? (
        <Alert tone="warn" title="Unconfirmed sends are clustering">
          <p>
            {marks} marked. Delivery events aren&rsquo;t arriving. Check the subscription posting to each endpoint listed.
          </p>
        </Alert>
      ) : null}
      {!sweeping && view.providers.length === 0 ? null : (
        <Card className="overflow-hidden p-0">
          {view.providers.length === 0 ? (
            <p className="type-body-sm p-5 text-muted-foreground">Every send in the window was confirmed.</p>
          ) : (
            <ul>
              {view.providers.map((provider) => (
                <li
                  key={provider.providerId ?? "no-provider"}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground">{provider.providerName ?? "No provider recorded"}</p>
                    <p className="type-body-sm truncate text-muted-foreground">
                      {provider.organizationName ? `${provider.organizationName} · ` : null}
                      {provider.adapter ? `${adapterLabel(provider.adapter)} · ` : null}
                      {provider.webhookUrl ? (
                        <span className="font-mono">{provider.webhookUrl}</span>
                      ) : (
                        "no endpoint answers for these"
                      )}
                    </p>
                  </div>
                  <Chip tone={sweeping && view.clustered ? "warn" : "value"} caps={false}>
                    {formatNumber(provider.marked)} unconfirmed
                  </Chip>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </section>
  );
}

function ProviderIdentityRates({ groups }: { groups: ProviderIdentityGroupView[] }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Providers by identity"
        description={`Bounce and complaint rates over ${RATE_WINDOW_DAYS} days, per provider account. Shows organizations sharing one AWS account.`}
      />
      <Card className="overflow-hidden p-0">
        {groups.length === 0 ? (
          <p className="type-body-sm p-5 text-muted-foreground">No providers yet.</p>
        ) : (
          <ul>
            {groups.map((group) => {
              const denominator = resolved(outcomeCounts(group));
              const bounced = rate(group.bounced, denominator);
              const complained = rate(group.complained, denominator);
              return (
                <li key={group.key} className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5 last:border-b-0">
                  <div className="min-w-0">
                    <p className="font-mono text-sm text-foreground">{group.identity ?? "Unknown identity"}</p>
                    <p className="type-body-sm text-muted-foreground">
                      {adapterLabel(group.adapter)} · {group.providerIds.length} {group.providerIds.length === 1 ? "provider" : "providers"} ·{" "}
                      {group.organizationNames.join(", ")}
                    </p>
                  </div>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="type-body-sm text-muted-foreground">
                      {formatNumber(group.delivered)} delivered
                    </span>
                    <Chip tone={group.bounced > 0 ? "issue" : "neutral"}>{formatRate(bounced)} bounced</Chip>
                    <Chip tone={group.complained > 0 ? "issue" : "neutral"}>{formatRate(complained, 2)} complained</Chip>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}

/** What admins did service-wide: the latest of the activity rows that belong to no organization. */
function ServiceActivity({ rows }: { rows: ActivityListItem[] }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Service activity"
        description="Admin actions outside any one organization, like granting admin access or deleting an organization."
        actions={
          <>
            <TextLink href="/admin/settings/system/mail" className="type-body-sm">
              System mail
            </TextLink>
            <TextLink href="/admin/settings/system/activity" className="type-body-sm">
              All service activity
            </TextLink>
          </>
        }
      />
      <Card className="overflow-hidden p-0">
        {rows.length === 0 ? (
          <p className="type-body-sm p-5 text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul>
            {rows.map((row) => (
              <ServiceActivityRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

const METRIC_TITLE: Record<StallMetric, string> = { bounce: "Bounce rate", complaint: "Complaint rate" };

function trimRate(value: number, digits: number): string {
  return formatRate(value, digits).replace(/\.?0+%$/, "%");
}

function Metric({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="type-body-sm font-semibold text-foreground">{title}</p>
      {children}
    </div>
  );
}

function QuotaMetric({ quota }: { quota: QuotaReading | null }) {
  if (!quota) {
    return (
      <Metric title="Send quota">
        <p className="type-body-sm text-muted-foreground">Not read yet.</p>
      </Metric>
    );
  }
  const share = quotaShare(quota);
  const tone: ThresholdTone = share === null ? "neutral" : share >= 1 ? "issue" : share >= QUOTA_WARN_SHARE ? "warn" : "good";
  return (
    <Metric title="Send quota">
      <p className="type-body-sm text-muted-foreground">
        <span className="font-mono tabular-nums text-foreground">{formatNumber(quota.sentLast24Hours ?? 0)}</span> of{" "}
        <span className="font-mono tabular-nums">{quota.max24HourSend != null ? formatNumber(quota.max24HourSend) : "—"}</span> in 24 hours
      </p>
      <ThresholdBar
        label="Sends in the last 24 hours against the daily quota"
        value={share}
        tone={tone}
        marks={[
          { value: QUOTA_WARN_SHARE, label: `Warn ${Math.round(QUOTA_WARN_SHARE * 100)}%` },
          { value: 1, label: "Quota" },
        ]}
      />
      <p className="type-body-sm text-muted-foreground">
        {quota.maxSendRate !== null ? `${formatNumber(quota.maxSendRate)} per second` : "No send rate reported"}
      </p>
    </Metric>
  );
}

function RateMetric({ metric, value, lines: stallLines }: { metric: StallMetric; value: number | null; lines: StallLines }) {
  const lines = stallLines[metric];
  const digits = RATE_DIGITS[metric];
  const tone: ThresholdTone =
    value === null ? "neutral" : value >= lines.stall * AT_RISK_SHARE ? "issue" : value >= lines.stall * WATCH_SHARE ? "warn" : "good";
  return (
    <Metric title={METRIC_TITLE[metric]}>
      {value === null ? (
        <p className="type-body-sm text-muted-foreground">No datapoint in 24 hours</p>
      ) : (
        <p className="font-mono text-sm tabular-nums text-foreground">{formatRate(value, digits)}</p>
      )}
      <ThresholdBar
        label={`${METRIC_TITLE[metric]} AWS reports against the pause lines`}
        value={value}
        tone={tone}
        marks={[
          { value: lines.stall, label: `${brand.name} ${trimRate(lines.stall, digits)}` },
          { value: lines.providerReview, label: `Provider review ${trimRate(lines.providerReview, digits)}` },
          { value: lines.providerPause, label: `Provider pause ${trimRate(lines.providerPause, digits)}` },
        ]}
      />
    </Metric>
  );
}

function RateMetrics({ rates, lines }: { rates: RatesReading | null; lines: StallLines }) {
  if (rates?.state === "ok") {
    return (
      <>
        <RateMetric metric="bounce" value={rates.bounceRate} lines={lines} />
        <RateMetric metric="complaint" value={rates.complaintRate} lines={lines} />
      </>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 md:col-span-2">
      <p className="type-body-sm font-semibold text-foreground">Bounce and complaint rates</p>
      {rates?.state === "denied" ? (
        <>
          <p className="type-body-sm text-foreground">
            Needs <code className="font-mono">{rates.permission}</code>
          </p>
          <p className="type-body-sm text-muted-foreground">
            Add it to this provider&rsquo;s IAM policy. See IAM policies in{" "}
            <code className="font-mono">docs/engineering.md</code>.
          </p>
        </>
      ) : (
        <p className="type-body-sm text-muted-foreground">
          {rates?.state === "failed" ? "AWS didn’t answer the last read. It’s tried again shortly." : "Not read yet."}
        </p>
      )}
    </div>
  );
}

function ProviderMetrics({ providers, lines }: { providers: ProviderMetricsView[]; lines: StallLines }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Provider limits and reputation"
        description="What each provider reports about itself. AWS acts on these, including mail sent elsewhere."
      />
      <Card className="overflow-hidden p-0">
        {providers.length === 0 ? (
          <p className="type-body-sm p-5 text-muted-foreground">No provider has reported limits or rates yet.</p>
        ) : (
          <ul>
            {providers.map((provider) => (
              <li key={provider.key} className="flex flex-col gap-4 border-b border-border p-5 last:border-b-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm text-foreground">{provider.identity ?? "Unknown identity"}</p>
                    <p className="type-body-sm text-muted-foreground">
                      {adapterLabel(provider.adapter)} · {provider.providerNames.join(", ")} · {provider.organizationNames.join(", ")}
                    </p>
                  </div>
                  <span className="flex shrink-0 items-center gap-2">
                    {provider.shared ? <Chip tone="signal">shared</Chip> : null}
                    {provider.quota?.enforcementStatus ? (
                      <Chip tone={provider.quota.enforcementStatus === "HEALTHY" ? "good" : "issue"}>
                        {provider.quota.enforcementStatus.toLowerCase().replaceAll("_", " ")}
                      </Chip>
                    ) : null}
                  </span>
                </div>
                <div className="grid gap-6 md:grid-cols-3">
                  <QuotaMetric quota={provider.quota} />
                  <RateMetrics rates={provider.rates} lines={lines} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

export function SystemScreen({
  health,
  loops,
  stuckLocks,
  queueByOrganization,
  unconfirmed,
  providerIdentityRates,
  providerMetrics,
  serviceActivity,
  bodyLifecycle,
  inboundLifecycle,
  lines,
}: {
  health: ServiceHealth;
  loops: LoopLivenessView[];
  stuckLocks: StuckLockView[];
  queueByOrganization: OrganizationQueueView[];
  unconfirmed: UnconfirmedClusterView;
  providerIdentityRates: ProviderIdentityGroupView[];
  providerMetrics: ProviderMetricsView[];
  serviceActivity: ActivityListItem[];
  bodyLifecycle: BodyLifecycleView;
  inboundLifecycle: BodyLifecycleView;
  lines: StallLines;
}) {
  return (
    <div className="flex flex-col gap-6">
      <LoopLiveness health={health} loops={loops} />
      <ProviderMetrics providers={providerMetrics} lines={lines} />
      <BucketLifecycle view={bodyLifecycle} kind="bodies" />
      <BucketLifecycle view={inboundLifecycle} kind="inbound" />
      <StuckLocks locks={stuckLocks} />
      <QueueByOrganization organizations={queueByOrganization} />
      <UnconfirmedCluster view={unconfirmed} sweeping={loops.some((loop) => loop.loop === "abandon" && loop.status === "ok")} />
      <ProviderIdentityRates groups={providerIdentityRates} />
      <ServiceActivity rows={serviceActivity} />
    </div>
  );
}
