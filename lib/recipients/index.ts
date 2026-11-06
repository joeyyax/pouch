/** One address as the organization knows it: what was sent to it, what happened, and what stops a send. */
import { and, arrayContains, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, domainUnsubscribes, listMemberships, messages, recipientHistory } from "@/lib/db/schema";
import type { ApiKeyMode, MessageStatus } from "@/lib/db/schema";
import { isEmailAddress, normalizeAddress } from "@/lib/addresses";
import { ApiError } from "@/lib/api/errors";
import { selectShape, type Selection } from "@/lib/api/shape";
import { findSuppressed, serializeSuppression, type SerializedSuppression } from "@/lib/messages/suppression";
import { recipientShape } from "@/lib/schemas/shapes";

/** Messages per list in the `history` expansion. */
export const RECIPIENT_HISTORY_LIMIT = 50;

export type RecipientKey = (typeof recipientShape.keys)[number];
export type RecipientSelection = Selection<RecipientKey, "history">;

export interface RecipientCaller {
  organizationId: string;
  /** Empty for a dashboard session or a key with no domain scope. */
  domainIds: string[];
  mode?: ApiKeyMode | undefined;
}

export interface SerializedRecipientMessage {
  id: string;
  subject: string;
  domain_id: string;
  status: MessageStatus;
  test_mode: boolean;
  created_at: string;
}

export interface SerializedRecipient {
  address: string;
  first_seen_at: string | null;
  last_sent_at: string | null;
  last_status: MessageStatus | null;
  domain_ids: string[];
  /** Messages addressed to it, by final status. The rest are still in flight. */
  messages: { total: number; delivered: number; bounced: number; complained: number; failed: number };
  bounce_count: number;
  complaint_count: number;
  last_delivered_at: string | null;
  last_bounced_at: string | null;
  last_complained_at: string | null;
  suppression: (SerializedSuppression & { added_by: string | null; source_message: SerializedRecipientMessage | null }) | null;
  unsubscribes: {
    lists: { list_id: string; unsubscribed_at: string | null }[];
    domains: { domain_id: string; unsubscribed_at: string }[];
  };
  history?: SerializedRecipientMessage[];
  incidents?: SerializedRecipientMessage[];
}

/** One address. A domain-scoped or test key is refused: the record spans every domain and both modes. */
export async function readRecipient(
  caller: RecipientCaller,
  address: string,
  selection: RecipientSelection = selectShape(recipientShape),
): Promise<SerializedRecipient> {
  const normalized = normalizeAddress(address);
  if (!isEmailAddress(normalized)) {
    throw new ApiError("validation_failed", `"${address}" isn't a valid address.`, { field: "address" });
  }
  const found = (await readRecipients(caller, [normalized], selection)).get(normalized);
  if (!found) throw new ApiError("not_found", `${normalized} has no messages, suppression or unsubscribe on file.`);
  return found;
}

/** Several addresses at once, keyed on the normalized form. An address with nothing on file is absent. */
export async function readRecipients(
  caller: RecipientCaller,
  addresses: string[],
  selection: RecipientSelection = selectShape(recipientShape),
): Promise<Map<string, SerializedRecipient>> {
  assertRecipientCaller(caller);
  const wanted = [...new Set(addresses.map(normalizeAddress))];
  if (wanted.length === 0) return new Map();
  const { organizationId } = caller;

  const known = await onFile(organizationId, wanted);
  if (known.length === 0) return new Map();

  const wants = (...keys: RecipientKey[]) => keys.some((key) => selection.has(key));
  const [counts, rollups, suppressions, unsubscribes, history] = await Promise.all([
    wants("last_sent_at", "last_status", "domain_ids", "messages") ? messageCounts(organizationId, known) : new Map<string, CountRow>(),
    wants("first_seen_at", "bounce_count", "complaint_count", "last_delivered_at", "last_bounced_at", "last_complained_at")
      ? rollupsFor(organizationId, known)
      : new Map<string, typeof recipientHistory.$inferSelect>(),
    wants("suppression") ? suppressionsFor(organizationId, known) : new Map<string, NonNullable<SerializedRecipient["suppression"]>>(),
    wants("unsubscribes") ? unsubscribesFor(organizationId, known) : new Map<string, SerializedRecipient["unsubscribes"]>(),
    selection.expands("history") ? historyFor(organizationId, known) : new Map<string, Pick<SerializedRecipient, "history" | "incidents">>(),
  ]);

  const result = new Map<string, SerializedRecipient>();
  for (const address of known) {
    const count = counts.get(address);
    const rollup = rollups.get(address);
    result.set(address, {
      address,
      first_seen_at: iso(rollup?.firstSeenAt),
      last_sent_at: iso(count?.last_sent_at),
      last_status: count?.last_status ?? null,
      domain_ids: count?.domain_ids ?? [],
      messages: {
        total: Number(count?.total ?? 0),
        delivered: Number(count?.delivered ?? 0),
        bounced: Number(count?.bounced ?? 0),
        complained: Number(count?.complained ?? 0),
        failed: Number(count?.failed ?? 0),
      },
      bounce_count: rollup?.bounceCount ?? 0,
      complaint_count: rollup?.complaintCount ?? 0,
      last_delivered_at: iso(rollup?.lastDeliveredAt),
      last_bounced_at: iso(rollup?.lastBouncedAt),
      last_complained_at: iso(rollup?.lastComplainedAt),
      suppression: suppressions.get(address) ?? null,
      unsubscribes: unsubscribes.get(address) ?? { lists: [], domains: [] },
      ...history.get(address),
    });
  }
  return result;
}

function assertRecipientCaller(caller: RecipientCaller): void {
  if (caller.domainIds.length > 0) {
    throw new ApiError("key_not_scoped", "This key is scoped to specific domains, and a recipient's record spans every domain.");
  }
  if (caller.mode === "test") throw new ApiError("key_not_scoped", "A test-mode key can't read a recipient, whose record holds live mail.");
}

/** The addresses the organization has sent to, suppressed or seen unsubscribe. */
async function onFile(organizationId: string, addresses: string[]): Promise<string[]> {
  const list = sql.join(
    addresses.map((address) => sql`${address}`),
    sql`, `,
  );
  const rows = await db.execute<{ address: string }>(sql`
    select a.address from unnest(array[${list}]::text[]) as a(address)
    where exists (select 1 from recipient_history h where h.organization_id = ${organizationId} and h.address = a.address)
      or exists (select 1 from suppressions s where s.organization_id = ${organizationId} and s.address = a.address)
      or exists (select 1 from domain_unsubscribes d where d.organization_id = ${organizationId} and d.address = a.address)
      or exists (
        select 1 from list_memberships l
        where l.organization_id = ${organizationId} and l.address = a.address and l.status = 'unsubscribed'
      )
      or exists (select 1 from messages m where m.organization_id = ${organizationId} and m.recipients @> array[a.address])
  `);
  return rows.map((row) => row.address);
}

interface CountRow extends Record<string, unknown> {
  address: string;
  last_sent_at: Date | string;
  last_status: MessageStatus;
  domain_ids: string[];
  total: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
}

async function messageCounts(organizationId: string, addresses: string[]): Promise<Map<string, CountRow>> {
  const list = sql.join(
    addresses.map((address) => sql`${address}`),
    sql`, `,
  );
  const rows = await db.execute<CountRow>(sql`
    select
      r.address,
      max(m.created_at) as last_sent_at,
      (array_agg(m.status order by m.created_at desc, m.id desc))[1] as last_status,
      array_agg(distinct m.domain_id) as domain_ids,
      count(*)::int as total,
      count(*) filter (where m.status = 'delivered')::int as delivered,
      count(*) filter (where m.status = 'bounced')::int as bounced,
      count(*) filter (where m.status = 'complained')::int as complained,
      count(*) filter (where m.status = 'failed')::int as failed
    from messages m, unnest(m.recipients) as r(address)
    where m.organization_id = ${organizationId}
      and m.recipients && array[${list}]::text[]
      and r.address in (${list})
    group by r.address
  `);
  return new Map(rows.map((row) => [row.address, row]));
}

async function rollupsFor(organizationId: string, addresses: string[]) {
  const rows = await db
    .select()
    .from(recipientHistory)
    .where(and(eq(recipientHistory.organizationId, organizationId), inArray(recipientHistory.address, addresses)));
  return new Map(rows.map((row) => [row.address, row]));
}

async function suppressionsFor(organizationId: string, addresses: string[]): Promise<Map<string, NonNullable<SerializedRecipient["suppression"]>>> {
  const rows = await findSuppressed(organizationId, addresses);
  if (rows.length === 0) return new Map();
  const sourceIds = rows.flatMap((row) => (row.sourceMessageId ? [row.sourceMessageId] : []));
  const [added, sources] = await Promise.all([
    db
      .select({ appliesTo: activity.appliesTo, actorLabel: activity.actorLabel })
      .from(activity)
      .where(
        and(
          eq(activity.organizationId, organizationId),
          eq(activity.action, "suppression.added"),
          inArray(
            activity.appliesTo,
            rows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(desc(activity.createdAt)),
    sourceIds.length > 0
      ? db
          .select(MESSAGE_SUMMARY)
          .from(messages)
          .where(and(eq(messages.organizationId, organizationId), inArray(messages.id, sourceIds)))
      : [],
  ]);
  const addedBy = new Map<string, string>();
  for (const row of added) if (row.appliesTo && !addedBy.has(row.appliesTo)) addedBy.set(row.appliesTo, row.actorLabel);
  const byId = new Map(sources.map((row) => [row.id, serializeMessageSummary(row)]));

  return new Map(
    rows.map((row) => [
      row.address,
      {
        ...serializeSuppression(row),
        added_by: addedBy.get(row.id) ?? null,
        source_message: row.sourceMessageId ? (byId.get(row.sourceMessageId) ?? null) : null,
      },
    ]),
  );
}

async function unsubscribesFor(organizationId: string, addresses: string[]): Promise<Map<string, SerializedRecipient["unsubscribes"]>> {
  const [fromLists, fromDomains] = await Promise.all([
    db
      .select({ address: listMemberships.address, listId: listMemberships.listId, unsubscribedAt: listMemberships.unsubscribedAt })
      .from(listMemberships)
      .where(
        and(
          eq(listMemberships.organizationId, organizationId),
          eq(listMemberships.status, "unsubscribed"),
          inArray(listMemberships.address, addresses),
        ),
      )
      .orderBy(listMemberships.listId),
    db
      .select({ address: domainUnsubscribes.address, domainId: domainUnsubscribes.domainId, createdAt: domainUnsubscribes.createdAt })
      .from(domainUnsubscribes)
      .where(and(eq(domainUnsubscribes.organizationId, organizationId), inArray(domainUnsubscribes.address, addresses)))
      .orderBy(domainUnsubscribes.domainId),
  ]);

  const result = new Map<string, SerializedRecipient["unsubscribes"]>();
  const entry = (address: string) => {
    const existing = result.get(address) ?? { lists: [], domains: [] };
    result.set(address, existing);
    return existing;
  };
  for (const row of fromLists) entry(row.address).lists.push({ list_id: row.listId, unsubscribed_at: iso(row.unsubscribedAt) });
  for (const row of fromDomains) entry(row.address).domains.push({ domain_id: row.domainId, unsubscribed_at: row.createdAt.toISOString() });
  return result;
}

const MESSAGE_SUMMARY = {
  id: messages.id,
  subject: messages.subject,
  domainId: messages.domainId,
  status: messages.status,
  testMode: messages.testMode,
  createdAt: messages.createdAt,
};

type MessageSummaryRow = { id: string; subject: string; domainId: string; status: MessageStatus; testMode: boolean; createdAt: Date };

function serializeMessageSummary(row: MessageSummaryRow): SerializedRecipientMessage {
  return {
    id: row.id,
    subject: row.subject,
    domain_id: row.domainId,
    status: row.status,
    test_mode: row.testMode,
    created_at: row.createdAt.toISOString(),
  };
}

async function historyFor(organizationId: string, addresses: string[]): Promise<Map<string, Pick<SerializedRecipient, "history" | "incidents">>> {
  const entries = await Promise.all(
    addresses.map(async (address) => {
      const toAddress = and(eq(messages.organizationId, organizationId), arrayContains(messages.recipients, [address]));
      const [history, incidents] = await Promise.all([
        db
          .select(MESSAGE_SUMMARY)
          .from(messages)
          .where(toAddress)
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(RECIPIENT_HISTORY_LIMIT),
        db
          .select(MESSAGE_SUMMARY)
          .from(messages)
          .where(and(toAddress, inArray(messages.status, ["bounced", "complained"])))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(RECIPIENT_HISTORY_LIMIT),
      ]);
      return [address, { history: history.map(serializeMessageSummary), incidents: incidents.map(serializeMessageSummary) }] as const;
    }),
  );
  return new Map(entries);
}

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}
