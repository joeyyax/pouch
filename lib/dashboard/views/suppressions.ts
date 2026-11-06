/**
 * The shapes the suppressions screen renders, and the pure helpers it calls.
 *
 * lib/dashboard/views is the client boundary: every value a screen needs at runtime lives here,
 * and nothing under it imports a module that reaches Postgres, object storage or Redis. A value
 * imported from one of those into a "use client" file drags the Postgres driver into the browser
 * bundle — which typecheck and lint both allow, and only the browser catches. Types are erased,
 * so a client component may still import one from a loader.
 */
import type { MessageStatus, SuppressionReason } from "@/lib/db/schema";
import { SUPPRESSION_REASONS } from "@/lib/db/enums";
import { addDays, startOfZonedDay } from "@/lib/time-zone";

export const REASON_LABEL: Record<SuppressionReason, string> = {
  hard_bounce: "Hard bounce",
  complaint: "Complaint",
  manual: "Manual",
};

/** What an import did, as the suppressions screen shows it. */
export interface SuppressionImportSummary {
  added: number;
  already_present: number;
  invalid: number;
  errors: { line: number | null; address: string; message: string }[];
}

/** Rows one page of the suppression list holds. It's the screen most likely to hold thousands. */
export const SUPPRESSIONS_PAGE_SIZE = 50;

export interface SuppressionPage {
  rows: SuppressionListItem[];
  /** Every row matching the filter, not just this page. */
  total: number;
  page: number;
  pageCount: number;
  /** The typo-tolerant index didn't answer this search. */
  searchDegraded: boolean;
}

export interface SuppressionListItem {
  id: string;
  address: string;
  reason: SuppressionReason;
  /** The provider's reason, verbatim, or the note a manual add carried. */
  detail: string | null;
  createdAt: Date;
  /** The message that caused it, when there was one. */
  source: { id: string; subject: string; domainName: string } | null;
  /** Where an imported row came from, such as `postmark`. */
  importedFrom: string | null;
}

/** Days the added-per-day trend covers, today included. */
export const SUPPRESSION_TREND_DAYS = 30;

export interface SuppressionSummary {
  /** Every suppression in the organization, by reason, largest first. Reasons with none are absent. */
  byReason: { reason: SuppressionReason; count: number }[];
  /** `YYYY-MM-DD`, oldest first, one per value in `added`. */
  days: string[];
  added: number[];
}

/** What narrows the list. Every field comes off the URL. */
export interface SuppressionListFilters {
  search?: string | undefined;
  reason?: SuppressionReason | undefined;
  /** Sending domain name of the message that caused it. */
  domain?: string | undefined;
  /** `YYYY-MM-DD`, inclusive, in the viewer's zone. */
  from?: string | undefined;
  to?: string | undefined;
  page?: number | undefined;
}

/** The filters in the screen's query string. The list and the export read the same names. */
export function readSuppressionListFilters(get: (name: string) => string | null | undefined): Omit<SuppressionListFilters, "page"> {
  const value = (name: string) => get(name)?.trim() || undefined;
  const reason = value("reason");
  return {
    search: value("address"),
    reason: (SUPPRESSION_REASONS as readonly string[]).includes(reason ?? "") ? (reason as SuppressionReason) : undefined,
    domain: value("domain"),
    from: value("from"),
    to: value("to"),
  };
}

/** The query string `readSuppressionListFilters` reads back. */
export function suppressionListQuery(filters: Omit<SuppressionListFilters, "page">): string {
  const query = new URLSearchParams();
  if (filters.search) query.set("address", filters.search);
  if (filters.reason) query.set("reason", filters.reason);
  if (filters.domain) query.set("domain", filters.domain);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

/** Rows of send history the detail screen shows. */
export const SUPPRESSION_HISTORY_LIMIT = 50;

export interface SuppressionHistoryItem {
  id: string;
  subject: string;
  domainName: string;
  status: MessageStatus;
  createdAt: Date;
}

export interface SuppressionDetail {
  id: string;
  address: string;
  reason: SuppressionReason;
  bounceType: string | null;
  detail: string | null;
  importedFrom: string | null;
  createdAt: Date;
  /** Who added it by hand, from the activity log. */
  addedBy: string | null;
  /** The message that caused it. Null when there was none or it's been deleted. */
  cause: SuppressionHistoryItem | null;
  /** Every bounce or complaint to this address on file, newest first. */
  incidents: SuppressionHistoryItem[];
  history: SuppressionHistoryItem[];
  /** Every message to this address, not just the ones in `history`. */
  historyTotal: number;
  counts: { bounces: number; complaints: number; lastDeliveredAt: Date | null; firstSeenAt: Date | null } | null;
}

/** Why removing this one is a risk, as the confirmation says it. */
export function removalConsequence(reason: SuppressionReason): string {
  if (reason === "hard_bounce") {
    return "This address bounced permanently. Another send most likely bounces too, counts against the domain's bounce rate and puts it straight back on the list.";
  }
  if (reason === "complaint") {
    return "The recipient marked mail as spam. Another send risks a second complaint, and mailbox providers throttle or block domains over complaint rates.";
  }
  return "Sends to it start going out again. A later bounce or complaint puts it straight back.";
}

/** A `YYYY-MM-DD` day as the instant it starts in `zone`, or undefined when it isn't one. */
export function dayStart(day: string | undefined, zone: string): Date | undefined {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  if (Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) return undefined;
  return startOfZonedDay(day, zone);
}

/** The last instant of a `YYYY-MM-DD` day in `zone`, so a range's end day is included. */
export function dayEnd(day: string | undefined, zone: string): Date | undefined {
  if (!dayStart(day, zone)) return undefined;
  return new Date(startOfZonedDay(addDays(day!, 1), zone).getTime() - 1);
}
