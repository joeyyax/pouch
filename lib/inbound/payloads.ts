import { sql } from "drizzle-orm";
import type { Executor } from "@/lib/db";

/** Events whose stored payload carries an inbound message's body. */
const BODY_EVENTS = sql`('inbound.received', 'address.received')`;

const SCRUBBED = sql`jsonb_set(jsonb_set(payload, '{data,text}', 'null'::jsonb), '{data,html}', 'null'::jsonb)`;

const HAS_BODY = sql`(payload->'data'->'text' <> 'null'::jsonb or payload->'data'->'html' <> 'null'::jsonb)`;

/** Nulls text and html in every stored webhook payload these messages went out in. */
export async function scrubInboundPayloads(
  executor: Executor,
  rows: { id: string; organizationId: string; receivedAt: Date }[],
): Promise<number> {
  const byOrganization = new Map<string, { id: string; receivedAt: Date }[]>();
  for (const row of rows) byOrganization.set(row.organizationId, [...(byOrganization.get(row.organizationId) ?? []), row]);

  let scrubbed = 0;
  for (const [organizationId, messages] of byOrganization) {
    // A delivery is never older than its message, so receivedAt bounds the scan on the organization index.
    const since = new Date(Math.min(...messages.map((message) => message.receivedAt.getTime())));
    const ids = sql.join(messages.map((message) => sql`${message.id}`), sql`, `);
    const updated = await executor.execute<{ id: string }>(sql`
      update webhook_deliveries set payload = ${SCRUBBED}
      where organization_id = ${organizationId}
        and event_type in ${BODY_EVENTS}
        and created_at >= ${since.toISOString()}::timestamptz
        and payload->'data'->>'id' in (${ids})
        and ${HAS_BODY}
      returning id
    `);
    scrubbed += updated.length;
  }
  return scrubbed;
}

/** Nulls the body in up to `limit` stored payloads whose message is already gone. Returns how many. */
export async function scrubOrphanedInboundPayloads(executor: Executor, limit: number): Promise<number> {
  const updated = await executor.execute<{ id: string }>(sql`
    update webhook_deliveries set payload = ${SCRUBBED}
    where id in (
      select d.id from webhook_deliveries d
      where d.event_type in ${BODY_EVENTS}
        and (d.payload->'data'->'text' <> 'null'::jsonb or d.payload->'data'->'html' <> 'null'::jsonb)
        and not exists (select 1 from inbound_messages m where m.id = d.payload->'data'->>'id')
      limit ${limit}
    )
    returning id
  `);
  return updated.length;
}
