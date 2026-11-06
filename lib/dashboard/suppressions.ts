/** The suppressions screen's reads. Writes are the capability in lib/messages/suppression-manage.ts. */
import { and, desc, eq, gte, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messages, suppressions } from "@/lib/db/schema";
import { readSuppression, suppressionFilters } from "@/lib/messages/suppression";
import { localDay } from "@/lib/dashboard/local-day";
import { addDays, startOfZonedDay, UTC, zonedDayKey } from "@/lib/time-zone";
import { fuzzyMatches } from "@/lib/search";
import { selectShape } from "@/lib/api/shape";
import { readRecipients, type SerializedRecipientMessage } from "@/lib/recipients";
import { recipientShape } from "@/lib/schemas/shapes";
import {
  dayEnd,
  dayStart,
  SUPPRESSION_TREND_DAYS,
  SUPPRESSIONS_PAGE_SIZE,
  type SuppressionDetail,
  type SuppressionHistoryItem,
  type SuppressionListFilters,
  type SuppressionPage,
  type SuppressionSummary,
} from "./views/suppressions";

/**
 * One page of the list, newest first. Paged rather than rendered whole: this is the screen
 * most likely to hold thousands of rows, and every one of them carries a Remove button a
 * keyboard has to tab through.
 */
export async function listSuppressions(
  organizationId: string,
  options: SuppressionListFilters = {},
  zone: string = UTC,
): Promise<SuppressionPage> {
  const term = options.search?.trim();
  const fuzzy = term ? await fuzzyMatches("suppressions", { organizationId, term }) : null;
  const where = and(
    eq(suppressions.organizationId, organizationId),
    await suppressionListWhere(organizationId, options, zone, fuzzy?.ids ?? []),
  );

  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(suppressions)
    .where(where);
  const total = counted?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / SUPPRESSIONS_PAGE_SIZE));
  const page = Math.min(Math.max(1, options.page ?? 1), pageCount);

  const rows = await db
    .select({
      suppression: suppressions,
      messageId: messages.id,
      subject: messages.subject,
      domainName: domains.name,
    })
    .from(suppressions)
    .leftJoin(messages, eq(messages.id, suppressions.sourceMessageId))
    .leftJoin(domains, eq(domains.id, messages.domainId))
    .where(where)
    .orderBy(desc(suppressions.createdAt), desc(suppressions.id))
    .limit(SUPPRESSIONS_PAGE_SIZE)
    .offset((page - 1) * SUPPRESSIONS_PAGE_SIZE);

  const items = rows.map((row) => ({
    id: row.suppression.id,
    address: row.suppression.address,
    reason: row.suppression.reason,
    detail: row.suppression.detail,
    createdAt: row.suppression.createdAt,
    source:
      row.messageId && row.subject && row.domainName
        ? { id: row.messageId, subject: row.subject, domainName: row.domainName }
        : null,
    importedFrom: row.suppression.source,
  }));

  return { rows: items, total, page, pageCount, searchDegraded: fuzzy?.degraded ?? false };
}

/**
 * The list's filters as one condition, without the organization. A domain the organization
 * doesn't hold matches nothing. `alsoIds` are the typo-tolerant index's matches for the search.
 */
export async function suppressionListWhere(
  organizationId: string,
  options: Omit<SuppressionListFilters, "page">,
  zone: string,
  alsoIds: string[] = [],
): Promise<SQL> {
  const term = options.search?.trim();
  const domainId = options.domain ? await domainIdByName(organizationId, options.domain) : undefined;
  if (options.domain && !domainId) return sql`false`;
  return (
    and(
      term
        ? or(
            ilike(suppressions.address, `%${escapeLike(term)}%`),
            alsoIds.length > 0 ? inArray(suppressions.id, alsoIds) : undefined,
          )
        : undefined,
      ...suppressionFilters({
        reason: options.reason,
        domainId,
        since: dayStart(options.from, zone),
        until: dayEnd(options.to, zone),
      }),
    ) ?? sql`true`
  );
}

/** The whole list by reason, largest first, and addresses added per day in `zone` over the trend window. */
export async function readSuppressionSummary(organizationId: string, zone: string, now = new Date()): Promise<SuppressionSummary> {
  const first = addDays(zonedDayKey(now, zone), -(SUPPRESSION_TREND_DAYS - 1));
  const since = startOfZonedDay(first, zone);
  const day = localDay(suppressions.createdAt, zone);
  const inOrganization = eq(suppressions.organizationId, organizationId);
  const count = sql<number>`count(*)::int`;

  const [reasons, daily] = await Promise.all([
    db
      .select({ reason: suppressions.reason, count })
      .from(suppressions)
      .where(inOrganization)
      .groupBy(suppressions.reason)
      .orderBy(desc(count)),
    db
      .select({ day, count })
      .from(suppressions)
      .where(and(inOrganization, gte(suppressions.createdAt, since)))
      .groupBy(day),
  ]);

  const byDay = new Map(daily.map((row) => [row.day, row.count]));
  const days = Array.from({ length: SUPPRESSION_TREND_DAYS }, (_, index) => addDays(first, index));
  return { byReason: reasons, days, added: days.map((key) => byDay.get(key) ?? 0) };
}

/** One suppression with what caused it and the address's send history, read through the API's recipient. Null for another organization's id. */
export async function readSuppressionDetail(organizationId: string, id: string): Promise<SuppressionDetail | null> {
  const row = await readSuppression(organizationId, id);
  if (!row || row.id !== id) return null;

  const recipient = (
    await readRecipients({ organizationId, domainIds: [] }, [row.address], selectShape(recipientShape, { include: ["history"] }))
  ).get(row.address);
  const suppression = recipient?.suppression;
  if (!recipient || !suppression || suppression.id !== id) return null;

  const listed = [...(recipient.history ?? []), ...(recipient.incidents ?? []), ...(suppression.source_message ? [suppression.source_message] : [])];
  const names = await domainNames(organizationId, listed.map((item) => item.domain_id));
  const item = (message: SerializedRecipientMessage): SuppressionHistoryItem => ({
    id: message.id,
    subject: message.subject,
    domainName: names.get(message.domain_id) ?? "",
    status: message.status,
    createdAt: new Date(message.created_at),
  });

  return {
    id: suppression.id,
    address: suppression.address,
    reason: suppression.reason,
    bounceType: suppression.bounce_type,
    detail: suppression.detail,
    importedFrom: suppression.source,
    createdAt: new Date(suppression.created_at),
    addedBy: suppression.added_by,
    cause: suppression.source_message ? item(suppression.source_message) : null,
    incidents: (recipient.incidents ?? []).map(item),
    history: (recipient.history ?? []).map(item),
    historyTotal: recipient.messages.total,
    counts: recipient.first_seen_at
      ? {
          bounces: recipient.bounce_count,
          complaints: recipient.complaint_count,
          lastDeliveredAt: recipient.last_delivered_at ? new Date(recipient.last_delivered_at) : null,
          firstSeenAt: new Date(recipient.first_seen_at),
        }
      : null,
  };
}

async function domainNames(organizationId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: domains.id, name: domains.name })
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), inArray(domains.id, unique)));
  return new Map(rows.map((domain) => [domain.id, domain.name]));
}

async function domainIdByName(organizationId: string, name: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), eq(domains.name, name)))
    .limit(1);
  return row?.id;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}
