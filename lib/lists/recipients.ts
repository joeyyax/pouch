/**
 * The recipients view (#7): every address a domain has sent to, derived from `messages` —
 * no table of its own, per the acceptance criteria. Domains, last state and message history
 * come from `messages` itself; suppressed and unsubscribed come from the tables that already
 * track those. A page, not a rollup: this recomputes on every read rather than maintaining a
 * fixed-size row the way `recipient_history` does for send-time warnings, which is a different
 * purpose (a hint at accept time) than this (a directory a person browses).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domainUnsubscribes, listMemberships } from "@/lib/db/schema";
import { normalizeAddress } from "@/lib/addresses";
import { findSuppressed } from "@/lib/messages/suppression";
import { fuzzyMatches } from "@/lib/search";

const PAGE_SIZE = 50;

export interface RecipientListItem {
  address: string;
  domains: string[];
  lastStatus: string;
  lastSentAt: Date;
  messageCount: number;
  /** Messages to this address by outcome. The rest are still in flight. */
  outcomes: RecipientOutcomes;
  suppressed: boolean;
  /** True when the address has unsubscribed from at least one list, or stopped a domain outright. */
  unsubscribed: boolean;
}

export interface RecipientOutcomes {
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
}

export interface RecipientPage {
  rows: RecipientListItem[];
  total: number;
  page: number;
  pageCount: number;
  /** The typo-tolerant index didn't answer this search. */
  searchDegraded: boolean;
}

interface RecipientRow extends Record<string, unknown> {
  address: string;
  domains: string[];
  last_status: string;
  last_sent_at: Date;
  message_count: string;
  delivered: string;
  bounced: string;
  complained: string;
  failed: string;
}

export async function listRecipients(organizationId: string, options: { search?: string; page?: number } = {}): Promise<RecipientPage> {
  const search = options.search ? normalizeAddress(options.search) : undefined;
  const page = Math.max(1, options.page ?? 1);
  const offset = (page - 1) * PAGE_SIZE;

  const fuzzy = search ? await fuzzyMatches("messages", { organizationId, term: search, on: ["recipients"] }) : null;
  const fuzzyAddresses = [...new Set(fuzzy?.matched.recipients ?? [])];
  const matches = search
    ? sql`and (r.address ilike ${`%${search}%`}${
        fuzzyAddresses.length > 0 ? sql` or r.address in (${sql.join(fuzzyAddresses.map((address) => sql`${address}`), sql`, `)})` : sql``
      })`
    : sql``;

  const [counted] = await db.execute<{ count: string }>(sql`
    select count(distinct r.address) as count
    from messages m, unnest(m.recipients) as r(address)
    where m.organization_id = ${organizationId}
      ${matches}
  `);
  const total = Number(counted?.count ?? 0);

  const rows = await db.execute<RecipientRow>(sql`
    select
      r.address as address,
      array_agg(distinct d.name order by d.name) as domains,
      (array_agg(m.status order by m.created_at desc))[1] as last_status,
      max(m.created_at) as last_sent_at,
      count(*) as message_count,
      count(*) filter (where m.status = 'delivered') as delivered,
      count(*) filter (where m.status = 'bounced') as bounced,
      count(*) filter (where m.status = 'complained') as complained,
      count(*) filter (where m.status = 'failed') as failed
    from messages m
    inner join domains d on d.id = m.domain_id
    , unnest(m.recipients) as r(address)
    where m.organization_id = ${organizationId}
      ${matches}
    group by r.address
    order by max(m.created_at) desc
    limit ${PAGE_SIZE} offset ${offset}
  `);

  const addresses = rows.map((row) => row.address);
  const suppressed = new Set((await findSuppressed(organizationId, addresses)).map((row) => row.address));
  const unsubscribed = await unsubscribedAddresses(organizationId, addresses);

  return {
    rows: rows.map((row) => ({
      address: row.address,
      domains: row.domains,
      lastStatus: row.last_status,
      lastSentAt: new Date(row.last_sent_at),
      messageCount: Number(row.message_count),
      outcomes: {
        delivered: Number(row.delivered),
        bounced: Number(row.bounced),
        complained: Number(row.complained),
        failed: Number(row.failed),
      },
      suppressed: suppressed.has(row.address),
      unsubscribed: unsubscribed.has(row.address),
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    searchDegraded: fuzzy?.degraded ?? false,
  };
}

/** Addresses with either a list membership marked unsubscribed or a domain-wide stop. */
async function unsubscribedAddresses(organizationId: string, addresses: string[]): Promise<Set<string>> {
  if (addresses.length === 0) return new Set();

  const [fromLists, fromDomains] = await Promise.all([
    db
      .select({ address: listMemberships.address })
      .from(listMemberships)
      .where(
        and(
          eq(listMemberships.organizationId, organizationId),
          eq(listMemberships.status, "unsubscribed"),
          inArray(listMemberships.address, addresses),
        ),
      ),
    db
      .select({ address: domainUnsubscribes.address })
      .from(domainUnsubscribes)
      .where(and(eq(domainUnsubscribes.organizationId, organizationId), inArray(domainUnsubscribes.address, addresses))),
  ]);

  return new Set([...fromLists, ...fromDomains].map((row) => row.address));
}

export { PAGE_SIZE as RECIPIENTS_PAGE_SIZE };
