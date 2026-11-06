/**
 * The shapes the settings screen renders, and the pure helpers it calls.
 *
 * lib/dashboard/views is the client boundary: every value a screen needs at runtime lives here,
 * and nothing under it imports a module that reaches Postgres, object storage or Redis. A value
 * imported from one of those into a "use client" file drags the Postgres driver into the browser
 * bundle — which typecheck and lint both allow, and only the browser catches. Types are erased,
 * so a client component may still import one from a loader.
 */
import type { ProviderStatus } from "@/lib/providers/serialize";

export type { OrganizationSummary, OwnerSummary } from "@/lib/organizations/summary";

/** One field an adapter's credentials take. Never carries a value — only what to ask for. */
export interface CredentialFieldSpec {
  name: string;
  description: string;
  required: boolean;
}

/** The provider an organization sends through, as its members see it. No credentials, no limits. */
export interface SendingProviderView {
  name: string;
  adapterLabel: string;
  status: ProviderStatus;
  /** Set while the provider throttles the provider. */
  backoffUntil: Date | null;
  /** Where an admin manages it: the shared parent for a tenant. */
  adminProviderId: string;
}

export type WorkerState = "healthy" | "silent" | "unknown";

/** One worker's own row: which one, and when it last said it was alive. */
export interface WorkerView {
  id: string;
  lastBeatAt: Date;
}

export interface ServiceHealth {
  /** "healthy" means at least one worker is alive — the honest floor, since the queue still drains. */
  worker: WorkerState;
  /** Every worker heartbeating inside the window, newest first. Empty when none is. */
  workers: WorkerView[];
}

export interface QueueSummary {
  depth: number;
  oldestQueuedAt: Date | null;
}
