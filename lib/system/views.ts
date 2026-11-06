/**
 * The shapes the service-wide operator reads return, and the pure rules over them.
 *
 * Its own file, with no runtime imports, because both sides of the client boundary need it: the
 * reads in `read.ts` reach Postgres and Redis, and a value imported from there into a
 * "use client" file drags those drivers into the browser bundle.
 */
import type { LoopName } from "@/lib/health/names";

export type { LoopName };

/** "ok" is inside the job's own window (derived from its interval, see lib/health/jobs.ts),
 * "stale" is past it, "failing" is inside it with the last run having thrown, and "never" is
 * no row at all. A freshly started worker and a dead one both read "never" until the first run
 * records, which is honest: nothing has run either way. */
export type JobState = "ok" | "stale" | "failing" | "never";

/** One loop's last run across the whole fleet. `intervalMs` is the loop's own cadence, for
 * reading "last run" against, and null only alongside `status: "never"`. */
export interface LoopLivenessView {
  loop: LoopName;
  label: string;
  status: JobState;
  lastRunAt: Date | null;
  intervalMs: number | null;
  /** Runs in a row that threw. Zero once one lands clean. */
  consecutiveFailures: number;
}

/** Failing first: it's running and wrong. Then silent, then never run. */
const ATTENTION_ORDER: Record<Exclude<JobState, "ok">, number> = { failing: 0, stale: 1, never: 2 };

/** Loops that need a look come first and show open; the rest fold behind a summary. Registry order within each. */
export function groupLoops(loops: LoopLivenessView[]): { attention: LoopLivenessView[]; healthy: LoopLivenessView[] } {
  const rank = (loop: LoopLivenessView) => (loop.status === "ok" ? -1 : ATTENTION_ORDER[loop.status]);
  return {
    attention: loops.filter((loop) => loop.status !== "ok").sort((a, b) => rank(a) - rank(b)),
    healthy: loops.filter((loop) => loop.status === "ok"),
  };
}

/** "17 loops alive", or "14 other loops alive" under rows that need a look. */
export function healthyLoopsLabel(healthy: number, hasAttention: boolean): string {
  return `${healthy} ${hasAttention ? "other " : ""}${healthy === 1 ? "loop" : "loops"} alive`;
}

/** A row a worker locked and never released — it crashed mid-send, or was killed. Never
 * resolves on its own; the age is what tells an operator this one needs a hand. */
/** What Admin calls the service's own mail, sent through the system from address. */
export const SERVICE_MAIL_LABEL = "System mail";

export interface StuckLockView {
  messageId: string;
  /** Null on the service's own mail. */
  organizationId: string | null;
  organizationName: string;
  lockedAt: Date;
  lockedBy: string;
}

/** One organization's own slice of the queue, for the operator's cross-org breakdown. */
export interface OrganizationQueueView {
  /** Null for the service's own mail. */
  organizationId: string | null;
  organizationName: string;
  depth: number;
  oldestQueuedAt: Date | null;
}

/** The window the unconfirmed count covers, on the mark rather than the send. */
export const UNCONFIRMED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Fewer marks than this in the window is never a cluster, whatever the share. */
export const UNCONFIRMED_CLUSTER_FLOOR = 20;

/** Share of the window's eligible sends that has to be marked before it reads as a cluster. */
export const UNCONFIRMED_CLUSTER_SHARE = 0.05;

/** Unconfirmed marks in the window for one provider, and where that provider's events land. */
export interface UnconfirmedProviderView {
  /** Null for marks on messages that never recorded a provider. */
  providerId: string | null;
  providerName: string | null;
  adapter: string | null;
  organizationName: string | null;
  marked: number;
  /** The endpoint the missing events should have reached. Null without a provider row. */
  webhookUrl: string | null;
}

/**
 * Messages marked unconfirmed in the window against the sends those marks were drawn from.
 * One mark is a provider gap; a cluster is Pouch's own event ingest dropping them.
 */
export interface UnconfirmedClusterView {
  marked: number;
  /** Sends old enough to have been marked and no older: one window, ending ABANDON_MS ago. */
  eligibleSends: number;
  /** `marked / eligibleSends`. Null with nothing eligible. */
  share: number | null;
  clustered: boolean;
  /** Heaviest first. Empty when nothing was marked. */
  providers: UnconfirmedProviderView[];
}

/** A cluster needs both the floor and the share: low volume can't trip it, high volume can't hide it. */
export function unconfirmedClustered(marked: number, eligibleSends: number): boolean {
  if (marked < UNCONFIRMED_CLUSTER_FLOOR) return false;
  return marked >= eligibleSends * UNCONFIRMED_CLUSTER_SHARE;
}

/**
 * Delivery, bounce and complaint counts grouped by the underlying provider identity —
 * what SES actually suspends on — rather than by Pouch's `providers` row or
 * organization. See docs/decisions.md, "A provider's identity comes from the provider,
 * never a guess."
 */
export interface ProviderIdentityGroupView {
  /** Stable across providers sharing this identity; unique per unidentified provider otherwise. */
  key: string;
  adapter: string;
  /** Null when the provider can't say, or hasn't answered yet — never merged with another null. */
  identity: string | null;
  /** Provider ids grouped under this identity, across every organization. */
  providerIds: string[];
  /** Organizations holding one of those providers, deduplicated. */
  organizationNames: string[];
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
}
