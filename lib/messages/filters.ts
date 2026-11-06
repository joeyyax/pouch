/**
 * What narrows a list of messages, shared by the dashboard's list, the export jobs and the
 * export route. No imports but the status union, so a "use client" file can read it too.
 */
import type { MessageStatus } from "@/lib/db/schema/messages";

export const NEEDS_ATTENTION: MessageStatus[] = ["deferred", "bounced", "complained", "failed"];

export interface MessageFilters {
  /** Domain name, not id: it's what the scope select and the URL carry. */
  domain?: string | undefined;
  /** Domain id. Set by the /v1 export route, which takes a domain id like every other filter there. */
  domainId?: string | undefined;
  /** Key id: the key that sent it. */
  keyId?: string | undefined;
  statuses?: MessageStatus[] | undefined;
  /** Matches a message carrying any of these tags. */
  tags?: string[] | undefined;
  /** Exact recipient match, on the normalized form. */
  address?: string | undefined;
  /** Message id, recipient or subject. Dashboard only; the API has no free-text search. */
  search?: string | undefined;
  /** Ids a typo-tolerant index matched `search` to, added to its exact matches. Dashboard only. */
  fuzzyIds?: string[] | undefined;
  since?: Date | undefined;
  until?: Date | undefined;
  /** Non-empty only for a domain-scoped API key: narrows to the domains the key can reach. */
  restrictToDomainIds?: string[] | undefined;
  /** Bulk mode (#7): narrows to one batch's messages — the batch detail page's message list. */
  batchId?: string | undefined;
  /** Queued messages held by a domain stall or a reputation suspension — what the overview's
   * queue card links to. */
  held?: boolean | undefined;
  /** Messages that took more than one attempt to send. */
  retried?: boolean | undefined;
  /** Messages whose body is withheld from every read. */
  sensitive?: boolean | undefined;
  /** A bounce or complaint reason, matched exactly. */
  reason?: string | undefined;
  /** Dashboard exports only: window by the screen's rules (a sent-only list on `sent_at`). Unset, `since` and `until` bound `created_at`. */
  screenWindow?: boolean | undefined;
}

/** The longest range the list's `days` param reads. */
export const MAX_LIST_DAYS = 365;

/** Filters read back from a job's JSON, with the dates they were stored as restored. */
export function reviveFilters(stored: Record<string, unknown> | null): MessageFilters {
  const filters = { ...stored } as MessageFilters & { since?: Date | string; until?: Date | string };
  if (filters.since) filters.since = new Date(filters.since);
  if (filters.until) filters.until = new Date(filters.until);
  return filters as MessageFilters;
}
