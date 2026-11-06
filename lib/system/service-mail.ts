/** The service's own mail and its suppression list, for operators in Admin. No organization reads either. */
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messages, suppressions, type MessageStatus, type SuppressionReason } from "@/lib/db/schema";
import { normalizeAddress } from "@/lib/addresses";
import { ApiError } from "@/lib/api/errors";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { keysetBefore } from "@/lib/db/keyset";

export const SERVICE_MAIL_PAGE_SIZE = 50;

export interface ServiceMailRow {
  id: string;
  to: string[];
  subject: string;
  status: MessageStatus;
  tags: string[];
  fromAddress: string;
  domainName: string;
  failureReason: string | null;
  /** Credential mail: the body is never shown, here or anywhere. */
  withheld: boolean;
  createdAt: Date;
}

export interface ServiceMailPage {
  rows: ServiceMailRow[];
  /** The last row's id, when there's an older page. */
  nextCursor: string | null;
}

/** Newest first, older than the `before` message when given. */
export async function listServiceMail(before: string | null = null, limit = SERVICE_MAIL_PAGE_SIZE): Promise<ServiceMailPage> {
  const rows = await db
    .select({
      id: messages.id,
      to: messages.recipients,
      subject: messages.subject,
      status: messages.status,
      tags: messages.tags,
      fromAddress: messages.fromAddress,
      domainName: domains.name,
      failureReason: messages.failureReason,
      bodyWithheld: messages.bodyWithheld,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(domains, eq(domains.id, messages.domainId))
    .where(
      and(
        isNull(messages.organizationId),
        before ? keysetBefore({ table: messages, sort: messages.createdAt, id: messages.id }, before) : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit).map(({ bodyWithheld, ...row }) => ({ ...row, withheld: bodyWithheld !== null }));
  return { rows: page, nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null };
}

export interface ServiceSuppressionRow {
  id: string;
  address: string;
  reason: SuppressionReason;
  detail: string | null;
  createdAt: Date;
}

/** Addresses system mail no longer sends to, from a bounce or complaint on it. */
export async function listServiceSuppressions(limit = 100): Promise<ServiceSuppressionRow[]> {
  return db
    .select({
      id: suppressions.id,
      address: suppressions.address,
      reason: suppressions.reason,
      detail: suppressions.detail,
      createdAt: suppressions.createdAt,
    })
    .from(suppressions)
    .where(isNull(suppressions.organizationId))
    .orderBy(desc(suppressions.createdAt), desc(suppressions.id))
    .limit(limit);
}

/** Lets system mail reach the address again. */
export async function removeServiceSuppression(rawAddress: string, actor: ActivityActor): Promise<string> {
  const address = normalizeAddress(rawAddress);
  const [removed] = await db
    .delete(suppressions)
    .where(and(isNull(suppressions.organizationId), eq(suppressions.address, address)))
    .returning({ id: suppressions.id });
  if (!removed) throw new ApiError("not_found", `${address} isn't on the service's suppression list.`);

  await recordActivity({ organizationId: null, action: "suppression.removed", actor, appliesTo: removed.id });
  return address;
}
