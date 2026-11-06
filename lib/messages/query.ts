import { MESSAGE_STATUSES, type MessageStatus } from "@/lib/db/schema/messages";
import { MAX_LIST_DAYS, NEEDS_ATTENTION } from "@/lib/messages/filters";
import { LIST_WINDOW_DAYS } from "@/lib/dashboard/views/messages";
import type { MessageFilters } from "@/lib/messages/filters";

export type SearchParams = Record<string, string | string[] | undefined>;

export interface MessagesQuery {
  filters: MessageFilters;
  /** Domain name, or "all". */
  scope: string;
  /** Key id, or "" for every key. */
  keyId: string;
  statuses: MessageStatus[];
  /** The deferred, bounced, complained, failed preset. */
  preset: boolean;
  /** Queued messages held by a domain stall or a reputation suspension. */
  heldPreset: boolean;
  /** Days back the list reaches. */
  days: number;
  /** Only messages that took more than one attempt. */
  retried: boolean;
  /** Only messages whose body is withheld. */
  sensitive: boolean;
  /** A bounce or complaint reason, verbatim. Empty for any. */
  reason: string;
  tags: string[];
  search: string;
  address: string;
  /** Where this page starts. Empty on the newest page. */
  cursor: { before?: string; after?: string };
  /** Whether anything narrows the list, which decides which empty state is honest. */
  narrowed: boolean;
}

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

const KNOWN: readonly string[] = MESSAGE_STATUSES;

/** Reads the list's filters off the URL. The URL is the only place they live. */
export function readMessagesQuery(params: SearchParams): MessagesQuery {
  const scope = one(params.domain) || "all";
  const presetParam = one(params.preset);
  const preset = presetParam === "attention";
  const heldPreset = presetParam === "held";
  const chosen = one(params.status)
    .split(",")
    .filter((status): status is MessageStatus => KNOWN.includes(status));
  const statuses = preset ? NEEDS_ATTENTION : chosen;
  const tags = one(params.tag)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const parsedDays = Number.parseInt(one(params.days), 10);
  const days = parsedDays >= 1 && parsedDays <= MAX_LIST_DAYS ? parsedDays : undefined;
  const retried = one(params.retried) === "1";
  const sensitive = one(params.sensitive) === "1";
  const reason = one(params.reason).trim();
  const search = one(params.q).trim();
  const address = one(params.address).trim();
  const keyId = one(params.key).trim();
  const before = one(params.before).trim();
  const after = one(params.after).trim();

  return {
    filters: {
      domain: scope === "all" ? undefined : scope,
      keyId: keyId || undefined,
      statuses: statuses.length > 0 ? statuses : undefined,
      tags: tags.length > 0 ? tags : undefined,
      search: search || undefined,
      address: address || undefined,
      held: heldPreset || undefined,
      retried: retried || undefined,
      sensitive: sensitive || undefined,
      reason: reason || undefined,
      since: days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : undefined,
    },
    scope,
    keyId,
    statuses,
    preset,
    heldPreset,
    days: days ?? LIST_WINDOW_DAYS,
    retried,
    sensitive,
    reason,
    tags,
    search,
    address,
    cursor: after ? { after } : before ? { before } : {},
    narrowed:
      scope !== "all" ||
      keyId !== "" ||
      statuses.length > 0 ||
      tags.length > 0 ||
      search !== "" ||
      address !== "" ||
      heldPreset ||
      retried ||
      sensitive ||
      reason !== "" ||
      (days ?? LIST_WINDOW_DAYS) !== LIST_WINDOW_DAYS,
  };
}
