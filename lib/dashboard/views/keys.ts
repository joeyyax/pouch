/**
 * The shapes the keys screen renders, and the pure helpers it calls.
 *
 * lib/dashboard/views is the client boundary: every value a screen needs at runtime lives here,
 * and nothing under it imports a module that reaches Postgres, object storage or Redis. A value
 * imported from one of those into a "use client" file drags the Postgres driver into the browser
 * bundle — which typecheck and lint both allow, and only the browser catches. Types are erased,
 * so a client component may still import one from a loader.
 */
import type { MessageStatus } from "@/lib/db/schema";

/** Days the per-key sends trend covers, today included. */
export const KEY_TREND_DAYS = 30;

export interface KeyListItem {
  id: string;
  name: string;
  secretPrefix: string;
  mode: "live" | "test";
  /** Domain names the key can send from. Empty means every domain. */
  domainNames: string[];
  /** The same scope as `domainNames`, by id — what an edit form submits back. */
  domainIds: string[];
  rateLimit: number;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  /** Sends per day in the viewer's zone over `KEY_TREND_DAYS`, oldest first. */
  daily: number[];
}

export interface KeyUsage {
  id: string;
  subject: string;
  to: string;
  recipientCount: number;
  status: MessageStatus;
  createdAt: Date;
}

export interface KeyDetailData extends KeyListItem {
  /** The most recent sends made with this key. */
  usage: KeyUsage[];
  /** Every send made with it, which is more than the list shows. */
  usageTotal: number;
}

export interface KeyFilterOption {
  id: string;
  name: string;
  revoked: boolean;
}

export interface KeyDomainOption {
  id: string;
  name: string;
  verified: boolean;
}
