import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, domains, messages, users } from "@/lib/db/schema";
import type { ApiKeyRevokedReason } from "@/lib/db/schema/api-keys";
import { selectShape } from "@/lib/api/shape";
import { statsShape } from "@/lib/schemas/stats";
import { bucketStartsOf, readStats, type StatsResponse } from "@/lib/stats";
import { foldTotals, openEnd } from "@/lib/dashboard/local-buckets";
import { addDays, startOfZonedDay, zonedDayKey } from "@/lib/time-zone";
import { KEY_TREND_DAYS, type KeyDetailData, type KeyFilterOption, type KeyListItem } from "@/lib/dashboard/views/keys";

/** Admin keys never show on an organization's own Keys screen. */
const ORGANIZATION_SCOPE = eq(apiKeys.scope, "organization");

const KEY_TREND_SELECTION = selectShape(statsShape, { fields: ["keys"] });

/** Sends per key per day in `zone` over the trend window, oldest first. A key with none has no entry. `apiKeyId` narrows it to one. */
export async function dailySendsByKey(
  organizationId: string,
  zone: string,
  options: { apiKeyId?: string; now?: Date } = {},
): Promise<Map<string, number[]>> {
  const now = options.now ?? new Date();
  const first = addDays(zonedDayKey(now, zone), -(KEY_TREND_DAYS - 1));
  const since = startOfZonedDay(first, zone);
  // Test keys send test mail, so every mode counts.
  const stats = (await readStats(
    { organizationId, domainIds: [] },
    { since, until: await openEnd(now), bucket: "hour", mode: "all", key: options.apiKeyId },
    KEY_TREND_SELECTION,
    now,
  )) as Pick<StatsResponse, "keys" | "window">;

  const keys = Array.from({ length: KEY_TREND_DAYS }, (_, index) => addDays(first, index));
  const starts = bucketStartsOf(stats.window);
  return new Map(
    stats.keys.flatMap((row) => {
      if (!row.key_id) return [];
      const days = foldTotals(starts, row.buckets, zone, "day");
      return [[row.key_id, keys.map((key) => days.get(key) ?? 0)] as const];
    }),
  );
}

/** Names for `ids`, or every domain in the organization when omitted. */
async function domainNamesById(organizationId: string, ids?: string[]): Promise<Map<string, string>> {
  if (ids?.length === 0) return new Map();
  const rows = await db
    .select({ id: domains.id, name: domains.name })
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), ids ? inArray(domains.id, ids) : undefined));
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function listKeys(organizationId: string, zone: string): Promise<KeyListItem[]> {
  const [rows, names, daily] = await Promise.all([
    db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.organizationId, organizationId), ORGANIZATION_SCOPE))
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id)),
    domainNamesById(organizationId),
    dailySendsByKey(organizationId, zone),
  ]);
  const empty = Array.from({ length: KEY_TREND_DAYS }, () => 0);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    secretPrefix: row.secretPrefix,
    mode: row.mode,
    // A domain deleted out from under a key leaves its id, which is still the honest answer.
    domainNames: row.domainIds.map((id) => names.get(id) ?? id),
    domainIds: row.domainIds,
    rateLimit: row.rateLimit,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    daily: daily.get(row.id) ?? empty,
  }));
}

export async function readKey(organizationId: string, id: string, zone: string): Promise<KeyDetailData | null> {
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.id, id), ORGANIZATION_SCOPE))
    .limit(1);
  if (!row) return null;

  const [names, daily] = await Promise.all([
    domainNamesById(organizationId, row.domainIds),
    dailySendsByKey(organizationId, zone, { apiKeyId: row.id }),
  ]);

  const [usage, [counted]] = await Promise.all([
    db
      .select({
        id: messages.id,
        subject: messages.subject,
        recipients: messages.recipients,
        status: messages.status,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.organizationId, organizationId), eq(messages.apiKeyId, row.id)))
      .orderBy(desc(messages.createdAt))
      .limit(5),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.organizationId, organizationId), eq(messages.apiKeyId, row.id))),
  ]);

  return {
    id: row.id,
    name: row.name,
    secretPrefix: row.secretPrefix,
    mode: row.mode,
    domainNames: row.domainIds.map((domainId) => names.get(domainId) ?? domainId),
    domainIds: row.domainIds,
    rateLimit: row.rateLimit,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    daily: daily.get(row.id) ?? Array.from({ length: KEY_TREND_DAYS }, () => 0),
    usage: usage.map((message) => ({
      id: message.id,
      subject: message.subject,
      to: message.recipients[0] ?? "",
      recipientCount: message.recipients.length,
      status: message.status,
      createdAt: message.createdAt,
    })),
    usageTotal: counted?.total ?? 0,
  };
}

/** Every organization key, revoked ones included, for the messages screen's key filter. */
export async function listKeyFilterOptions(organizationId: string): Promise<KeyFilterOption[]> {
  const rows = await db
    .select({ id: apiKeys.id, name: apiKeys.name, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, organizationId), ORGANIZATION_SCOPE))
    .orderBy(asc(apiKeys.name));
  return rows.map((row) => ({ id: row.id, name: row.name, revoked: row.revokedAt !== null }));
}

export interface AdminKeyListItem {
  id: string;
  name: string;
  secretPrefix: string;
  creatorName: string | null;
  creatorEmail: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
  revokedReason: ApiKeyRevokedReason | null;
  /** Not revoked, but refused on every request because its creator isn't an admin. */
  refused: boolean;
}

/** Every admin key, newest first. */
export async function listAdminKeys(): Promise<AdminKeyListItem[]> {
  const rows = await db
    .select({ key: apiKeys, creatorName: users.name, creatorEmail: users.email, creatorIsAdmin: users.admin })
    .from(apiKeys)
    .leftJoin(users, eq(users.id, apiKeys.createdBy))
    .where(eq(apiKeys.scope, "admin"))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));

  return rows.map(({ key, creatorName, creatorEmail, creatorIsAdmin }) => ({
    id: key.id,
    name: key.name,
    secretPrefix: key.secretPrefix,
    creatorName,
    creatorEmail,
    lastUsedAt: key.lastUsedAt,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt,
    revokedReason: key.revokedReason,
    refused: !key.revokedAt && !creatorIsAdmin,
  }));
}
