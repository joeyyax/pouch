import { and, eq, sql } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { bulkFanoutRecipients } from "@/lib/db/schema";
import { sha256 } from "@/lib/crypto";
import { ApiError } from "@/lib/api/errors";
import type { DomainLayout, LayoutOverrides } from "@/lib/domains/layout";
import { applyLayoutOverrides, renderLayout } from "@/lib/domains/layout";
import { logger } from "@/lib/logger";
import { sendBulkFanoutAlert } from "@/lib/mail/alerts/bulk-fanout";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { LIST_UNSUBSCRIBE_HEADER } from "@/lib/schemas/email";

const log = logger.child("messages:bulk-detect");

/**
 * Distinct recipients on one rendered body, in one day, before it's a blast rather than a
 * busy Tuesday. A single request may already legitimately reach the provider's per-request
 * recipient cap (50); four times that on the exact same body, accumulated across separate
 * requests, is fan-out a per-request cap can't see. Configurable per deployment.
 */
export const BULK_FANOUT_THRESHOLD = Number(process.env.BULK_FANOUT_THRESHOLD ?? "200");

/**
 * The bytes actually sent: html after layout wrapping, plus text. Mirrors worker/send.ts's
 * wrap condition so the hash matches what the recipient's client renders, not what the
 * caller typed. Hashing the raw request instead would hash away the one thing that makes a
 * templated, per-recipient send look different from a blast: the substituted result.
 */
export function renderedBodyHash(
  html: string | null,
  text: string | null,
  wantsLayout: boolean,
  layout: DomainLayout | null,
  domainName: string,
  overrides: LayoutOverrides | null = null,
): string {
  const wrapped = wantsLayout && layout && html ? renderLayout(html, applyLayoutOverrides(layout, overrides), domainName) : html;
  return sha256(JSON.stringify({ html: wrapped, text }));
}

function hasListUnsubscribe(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === LIST_UNSUBSCRIBE_HEADER);
}

export interface FanoutCheck {
  organizationId: string;
  apiKeyId: string;
  bodyHash: string;
  recipients: string[];
  headers: Record<string, string>;
  /** Whether the domain's provider carries custom headers at all. Mailpace doesn't. */
  providerCarriesHeaders: boolean;
}

/**
 * Records this call's recipients against the body hash's ledger for today and throws once the
 * running distinct count crosses the threshold without List-Unsubscribe on the request. A
 * recipient already on file for today, hash and key doesn't count twice — the ledger tracks
 * who has received this body, not how many times a request named them.
 *
 * A header the provider drops in transit clears nothing: Mailpace strips every custom header,
 * so a List-Unsubscribe on the request would never reach the recipient, and accepting it here
 * would tell us this was enforced when it wasn't. That case refuses outright, before checking
 * for the header at all.
 *
 * Test-mode sends never reach a real recipient, so the caller skips this for them entirely,
 * matching the domain-stall guard (#94): test mode counts toward neither rate.
 */
export async function checkFanout(check: FanoutCheck, executor: Executor = db): Promise<void> {
  if (check.recipients.length === 0) return;

  const day = (await dbNow(executor)).toISOString().slice(0, 10);
  const ledgerScope = and(
    eq(bulkFanoutRecipients.apiKeyId, check.apiKeyId),
    eq(bulkFanoutRecipients.bodyHash, check.bodyHash),
    eq(bulkFanoutRecipients.day, day),
  );

  // Read before the insert, so a count that was already past the threshold can be told apart
  // from the call that pushes it over — the alert fires once, on the crossing itself.
  const [beforeRow] = await executor.select({ count: sql<number>`count(*)::int` }).from(bulkFanoutRecipients).where(ledgerScope);
  const before = beforeRow?.count ?? 0;

  const rows = check.recipients.map((address) => ({
    organizationId: check.organizationId,
    apiKeyId: check.apiKeyId,
    bodyHash: check.bodyHash,
    day,
    recipientHash: sha256(address),
  }));

  await executor.insert(bulkFanoutRecipients).values(rows).onConflictDoNothing();

  const [row] = await executor.select({ count: sql<number>`count(*)::int` }).from(bulkFanoutRecipients).where(ledgerScope);
  const count = row?.count ?? 0;

  if (before <= BULK_FANOUT_THRESHOLD && count > BULK_FANOUT_THRESHOLD) {
    // Best-effort: a notification failing here must never block the send it's reporting on.
    await sendBulkFanoutAlert({
      organizationId: check.organizationId,
      apiKeyId: check.apiKeyId,
      bodyHash: check.bodyHash,
      day,
      count,
      threshold: BULK_FANOUT_THRESHOLD,
    }).catch((err) => {
      const reason = safeErrorMessage(err);
      log.warn(`couldn't send the bulk-fanout alert for key ${check.apiKeyId}: ${reason}`);
    });
  }

  if (count <= BULK_FANOUT_THRESHOLD) return;

  if (!check.providerCarriesHeaders) {
    // A provider fact, same as lib/bulk/create.ts's own bulk_not_allowed — "provider_incapable"
    // names the same reason a batch send would fail for, on this domain's provider.
    throw new ApiError(
      "bulk_not_allowed",
      "This domain's provider can't carry List-Unsubscribe, so this body can't be sent as bulk from here. Move the domain to a provider that can, or don't send it this way.",
      { detail: { reason: "provider_incapable", recipients: count, threshold: BULK_FANOUT_THRESHOLD } },
    );
  }

  if (hasListUnsubscribe(check.headers)) return;

  throw new ApiError(
    "list_unsubscribe_required",
    `This exact message has reached ${count} recipients today, which mailbox providers treat as bulk. Add a List-Unsubscribe header to keep sending it.`,
    { field: "headers", detail: { recipients: count, threshold: BULK_FANOUT_THRESHOLD } },
  );
}
