/**
 * The shapes the overview screen renders, and the pure helpers it calls.
 *
 * lib/dashboard/views is the client boundary: every value a screen needs at runtime lives here,
 * and nothing under it imports a module that reaches Postgres, object storage or Redis. A value
 * imported from one of those into a "use client" file drags the Postgres driver into the browser
 * bundle — which typecheck and lint both allow, and only the browser catches. Types are erased,
 * so a client component may still import one from a loader.
 */
import type { DomainStallView } from "@/lib/domains/guard";
import type { Standing } from "@/lib/reputation/standing";

export type { Condition, ConditionKey } from "@/lib/metrics/conditions";
export type { Latency } from "@/lib/metrics/duration";
export type { OutcomeCounts, Outcome } from "@/lib/metrics/rates";
export type { MetricsWindowDays } from "@/lib/metrics/window";

/** One day of the volume chart. `pending` is queued, sent or deferred — no outcome yet. */
export interface VolumeDay {
  date: Date;
  /** `09-24`, or `14:00` in the one-day window. */
  label: string;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  pending: number;
}

/** What the queue looks like at the moment the page rendered, not over the window. */
export interface QueueReading {
  /** Waiting on the worker: due now and not yet claimed. */
  due: number;
  /** Waiting on backoff, which is the queue working as intended. */
  backingOff: number;
  /** Held by a domain stall or a suspension that holds the queue, so neither due nor backing off. */
  held: number;
  /** Held by each stalled domain. Empty when the organization's suspension holds everything. */
  heldByDomain: { domainId: string; count: number; oldestMs: number }[];
  /** Whether the organization's own suspension holds its queue. */
  organizationHeld: boolean;
  /** Whether the organization's own suspension fails its queued mail. */
  organizationFails: boolean;
  /** Age of the oldest held message. Null when nothing is held. */
  oldestHeldMs: number | null;
  /** Held by a worker mid-send. */
  inFlight: number;
  /** Handed over and unresolved past the silent threshold. */
  silent: number;
  /** Age of the oldest due message. Null when nothing is due. */
  oldestDueMs: number | null;
  /** Mean attempts among messages that did send, this window and the one before. */
  retryPressure: number;
  previousRetryPressure: number;
}

export interface DomainMetrics {
  domainId: string;
  domainName: string;
  counts: import("@/lib/metrics/rates").OutcomeCounts;
  queueP95: number | null;
  lastSentAt: Date | null;
  /** The stall guard is holding this domain's queue. Null means it's sending normally. */
  stall: DomainStallView | null;
  /** Accepted per day, aligned with `MetricsOverview.volume`. */
  daily: number[];
}

/** A provider's reason, verbatim, and how many messages carried it. */
export interface BounceReason {
  reason: string;
  count: number;
  /** The one message, or the message list narrowed to these. */
  href: string;
}

export interface MetricsOverview {
  days: import("@/lib/metrics/window").MetricsWindowDays;
  since: Date;
  until: Date;
  counts: import("@/lib/metrics/rates").OutcomeCounts;
  previousCounts: import("@/lib/metrics/rates").OutcomeCounts;
  queue: QueueReading;
  /** Accepted to handed over. */
  queueLatency: import("@/lib/metrics/duration").Latency;
  /** Handed over to delivered. */
  providerLatency: import("@/lib/metrics/duration").Latency;
  endToEndLatency: import("@/lib/metrics/duration").Latency;
  volume: VolumeDay[];
  /** The previous window, day for day, aligned with `volume` by index. */
  previousVolume: VolumeDay[];
  domains: DomainMetrics[];
  bounceReasons: BounceReason[];
  conditions: import("@/lib/metrics/conditions").Condition[];
  /** Whether anything has ever been sent, which separates "nothing yet" from "nothing lately". */
  everSent: boolean;
  /** Whether a live message has ever been sent. Every count excludes test mode. */
  everSentLive: boolean;
  reputation: {
    standing: Standing;
    /** Domains that aren't healthy, worst first. */
    attention: { id: string; name: string; standing: Standing }[];
    /** One sentence on why it isn't healthy. Null when it is. */
    reason: string | null;
    /** The stall lines its rates are read against. */
    lines: import("@/lib/domains/guard").StallLines;
  };
}
