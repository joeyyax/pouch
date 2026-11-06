import type { MessageStatus } from "@/lib/db/schema/messages";

export interface MessagesLink {
  domain?: string | undefined;
  /** Key id. */
  key?: string;
  statuses?: MessageStatus[];
  days?: number;
  held?: boolean;
  retried?: boolean;
  sensitive?: boolean;
  /** A bounce or complaint reason, verbatim. */
  reason?: string;
  /** One recipient address. */
  address?: string;
  tag?: string;
}

/** A link to the message list with these filters, as `readMessagesQuery` reads them. */
export function messagesHref({ domain, key, statuses, days, held, retried, sensitive, reason, address, tag }: MessagesLink): string {
  const params = new URLSearchParams();
  if (held) params.set("preset", "held");
  if (domain) params.set("domain", domain);
  if (key) params.set("key", key);
  if (address) params.set("address", address);
  if (tag) params.set("tag", tag);
  if (statuses && statuses.length > 0) params.set("status", statuses.join(","));
  if (retried) params.set("retried", "1");
  if (sensitive) params.set("sensitive", "1");
  if (reason) params.set("reason", reason);
  if (days) params.set("days", String(days));
  const query = params.toString();
  return query ? `/messages?${query}` : "/messages";
}
