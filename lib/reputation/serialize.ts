/** A domain's reputation detail as `GET /v1/domains/:id?include=reputation` returns it. */
import { BLOCKLISTS, type BlocklistId } from "@/lib/blocklists/lists";
import type { BlocklistStatus } from "@/lib/blocklists/status";
import { TENANT_VOLUME_DAYS } from "@/lib/providers/provider-metrics";
import type { DomainReputation } from "./read";
import { BASELINE_DAYS, SIGNAL_WINDOW_HOURS, type Finding, type MetricReading } from "./standing";

export interface SerializedMetricReading {
  count: number;
  /** Resolved messages: delivered, bounced, complained and failed. */
  denominator: number;
  /** Null below the volume a rate needs. */
  rate: number | null;
  previous_rate: number | null;
  delta: number | null;
  watch_line: number;
  at_risk_line: number;
  stall_line: number;
  provider_review_line: number;
  provider_pause_line: number;
}

export interface SerializedDomainReputation {
  /** Every finding behind the standing, worst first. `standing_reason` is the first one's. */
  findings: Pick<Finding, "kind" | "standing" | "title" | "body" | "action">[];
  /** The guard's 7 days, then 30, each against the window before it. */
  windows: { days: number; bounce: SerializedMetricReading; complaint: SerializedMetricReading }[];
  /** The receiving servers' words for recent bounces and complaints, grouped. */
  reasons: { status: "bounced" | "complained"; reason: string; kind: string | null; count: number; last_at: string }[];
  /** Null on a domain with no sends to read. */
  signals: {
    window_hours: number;
    baseline_days: number;
    recent_total: number;
    baseline_total: number;
    recent_recipients: number;
    first_time_recipients: number;
    suppressed_rejections: number;
  } | null;
  blocklists: {
    /** `off` when the install has no Spamhaus key, `paused` when the key fails or the day's budget is spent. */
    state: "on" | "off" | "paused";
    lists: {
      list: BlocklistId;
      listed: boolean;
      code: string | null;
      reason: string | null;
      listed_since: string | null;
      expires_at: string | null;
      checked_at: string | null;
      last_error_at: string | null;
    }[];
    links: { domain: string; list: BlocklistId; code: string; reason: string; messages: number; last_sent_at: string }[];
  };
  /** Open findings SES reports on the organization's tenant. */
  provider_findings: { type: string; impact: string | null; description: string | null; opened_at: string }[];
  /** SES's own counts for the organization, every domain on the tenant. Null off a tenant. */
  tenant_volume: { days: number; sends: number; bounces: number; complaints: number } | null;
}

function reading(value: MetricReading): SerializedMetricReading {
  return {
    count: value.count,
    denominator: value.denominator,
    rate: value.rate,
    previous_rate: value.previousRate,
    delta: value.delta,
    watch_line: value.watchLine,
    at_risk_line: value.atRiskLine,
    stall_line: value.stallLine,
    provider_review_line: value.providerReviewLine,
    provider_pause_line: value.providerPauseLine,
  };
}

function blocklistState(status: BlocklistStatus): SerializedDomainReputation["blocklists"]["state"] {
  if (status.state === "on") return "on";
  if (status.state === "key_invalid" || status.state === "paused") return "paused";
  return "off";
}

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

export function serializeDomainReputation(reputation: DomainReputation, now: Date): SerializedDomainReputation {
  const { signals, blocklists, tenantVolume } = reputation;
  return {
    findings: reputation.findings.map(({ kind, standing, title, body, action }) => ({ kind, standing, title, body, action })),
    windows: reputation.windows.map((window) => ({ days: window.days, bounce: reading(window.bounce), complaint: reading(window.complaint) })),
    reasons: reputation.reasons.map((reason) => ({
      status: reason.status,
      reason: reason.reason,
      kind: reason.kind,
      count: reason.count,
      last_at: reason.lastAt.toISOString(),
    })),
    signals: signals
      ? {
          window_hours: SIGNAL_WINDOW_HOURS,
          baseline_days: BASELINE_DAYS,
          recent_total: signals.recentTotal,
          baseline_total: signals.baselineTotal,
          recent_recipients: signals.recentRecipients,
          first_time_recipients: signals.firstTimeRecipients,
          suppressed_rejections: signals.suppressedRejections,
        }
      : null,
    blocklists: {
      state: blocklistState(blocklists.status),
      lists: BLOCKLISTS.map((list) => {
        const check = blocklists.checks.find((row) => row.list === list);
        return {
          list,
          listed: isListed(check, now),
          code: check?.code ?? null,
          reason: check?.reason ?? null,
          listed_since: iso(check?.listedSince),
          expires_at: iso(check?.expiresAt),
          checked_at: iso(check?.checkedAt),
          last_error_at: iso(check?.lastErrorAt),
        };
      }),
      links: blocklists.links.map((link) => ({
        domain: link.domain,
        list: link.list,
        code: link.code,
        reason: link.reason,
        messages: link.messages ?? 0,
        last_sent_at: link.lastSentAt.toISOString(),
      })),
    },
    provider_findings: reputation.providerFindings.map((finding) => ({
      type: finding.type,
      impact: finding.impact,
      description: finding.description,
      opened_at: finding.openedAt.toISOString(),
    })),
    tenant_volume: tenantVolume
      ? { days: TENANT_VOLUME_DAYS, sends: tenantVolume.sends, bounces: tenantVolume.bounces, complaints: tenantVolume.complaints }
      : null,
  };
}

/** A listing that lapses on its own, as ZRD's do, stops counting at `expires_at`. */
export function isListed(check: { status: string | null; expiresAt: Date | null } | undefined, now: Date): boolean {
  return check?.status === "listed" && (!check.expiresAt || check.expiresAt > now);
}
