/** Blocklist listings as standing reads them: each sending domain's own, and its recent links'. */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { activeDomainListings } from "@/lib/blocklists/domains";
import type { BlocklistId } from "@/lib/blocklists/lists";
import { SIGNAL_WINDOW_HOURS, type BlocklistListing } from "./standing";

const HOUR_MS = 60 * 60 * 1000;

export interface LinkedListingRow extends BlocklistListing {
  lastSentAt: Date;
}

/** Listed link domains in mail sent over the signal window, per sending domain. */
export async function recentLinkListings(organizationId: string, now: Date, domainIds?: string[]): Promise<Map<string, LinkedListingRow[]>> {
  const since = new Date(now.getTime() - SIGNAL_WINDOW_HOURS * HOUR_MS);
  const rows = await db.execute<{ domain_id: string; domain: string; list: BlocklistId; code: string; reason: string; messages: number; last_sent_at: string }>(sql`
    select m.domain_id,
           l->>'domain' as domain,
           l->>'list' as list,
           l->>'code' as code,
           l->>'reason' as reason,
           count(distinct m.id)::int as messages,
           max(m.sent_at) as last_sent_at
    from ${messages} m
    cross join lateral jsonb_array_elements(m.link_listings) as l
    where m.organization_id = ${organizationId}
      and m.link_listings is not null
      and m.sent_at >= ${since.toISOString()}::timestamptz
      and m.sent_at < ${now.toISOString()}::timestamptz
      and m.test_mode = false
      ${domainIds ? sql`and m.domain_id in (${sql.join(domainIds.map((id) => sql`${id}`), sql`, `)})` : sql``}
    group by 1, 2, 3, 4, 5
  `);
  const byDomain = new Map<string, LinkedListingRow[]>();
  for (const row of rows) {
    const listing: LinkedListingRow = {
      domain: row.domain,
      source: "link",
      list: row.list,
      code: row.code,
      reason: row.reason,
      messages: Number(row.messages),
      lastSentAt: new Date(row.last_sent_at),
    };
    byDomain.set(row.domain_id, [...(byDomain.get(row.domain_id) ?? []), listing]);
  }
  return byDomain;
}

/** Both kinds of listing, keyed by sending domain id. */
export async function readBlocklistListings(organizationId: string, now: Date, domainIds?: string[]): Promise<Map<string, BlocklistListing[]>> {
  const [own, linked] = await Promise.all([activeDomainListings(organizationId, now, domainIds), recentLinkListings(organizationId, now, domainIds)]);
  const byDomain = new Map<string, BlocklistListing[]>();
  for (const [domainId, rows] of own) {
    byDomain.set(
      domainId,
      rows.map((row) => ({ domain: "", source: "sending", list: row.list, code: row.code ?? "", reason: row.reason ?? "listed" })),
    );
  }
  for (const [domainId, rows] of linked) {
    byDomain.set(domainId, [...(byDomain.get(domainId) ?? []), ...rows.map(({ lastSentAt: _lastSentAt, ...listing }) => listing)]);
  }
  return byDomain;
}
