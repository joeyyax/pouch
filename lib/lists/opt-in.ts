/**
 * Double opt-in (#7). Sending the confirmation email and redeeming its link. Sending is called
 * only from `worker/list-confirm.ts` — never from the request path that created the pending
 * membership, so a caller adding a member never waits on a mail send, and this adapter is free
 * to import `lib/messages/create.ts` without creating a cycle back into it.
 */
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, lists, listMemberships } from "@/lib/db/schema";
import type { ListMembershipRow } from "@/lib/db/schema";
import { acceptDashboardMessage } from "@/lib/messages/create";
import { notifyQueued } from "@/lib/messages/queue";
import { hostedConfirmUrl } from "@/lib/api/urls";
import { enqueueDomainScopedWebhookEvent } from "@/lib/webhooks/dispatch";
import { newId } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { FONT_STACK, PALETTE, textOn } from "@/lib/brand-palette";
import { HEX_COLOR } from "@/lib/domains/layout";
import { escapeHtml } from "@/lib/format/html";
import { signSubjectToken, verifySubjectToken } from "./tokens";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("lists:opt-in");

interface ListAndDomain {
  membership: ListMembershipRow;
  listName: string;
  domainId: string;
  domainName: string;
  hasLayout: boolean;
  accent: string | null;
  confirmUrl: string | null;
}

async function membershipContext(membershipId: string): Promise<ListAndDomain | null> {
  const [row] = await db
    .select({
      membership: listMemberships,
      listName: lists.name,
      domainId: lists.domainId,
      domainName: domains.name,
      layout: domains.layout,
      confirmUrl: domains.confirmUrl,
    })
    .from(listMemberships)
    .innerJoin(lists, eq(lists.id, listMemberships.listId))
    .innerJoin(domains, eq(domains.id, lists.domainId))
    .where(eq(listMemberships.id, membershipId))
    .limit(1);
  if (!row) return null;
  return {
    membership: row.membership,
    listName: row.listName,
    domainId: row.domainId,
    domainName: row.domainName,
    hasLayout: row.layout !== null,
    accent: row.layout?.accent ?? null,
    confirmUrl: row.confirmUrl,
  };
}

/** Pending memberships whose confirmation hasn't been queued yet. Polled by the worker. */
export async function pendingConfirmations(limit: number): Promise<ListMembershipRow[]> {
  return db
    .select()
    .from(listMemberships)
    .where(
      and(
        eq(listMemberships.status, "pending"),
        eq(listMemberships.doubleOptIn, true),
        isNull(listMemberships.confirmationSentAt),
        lt(listMemberships.confirmationAttempts, MAX_CONFIRMATION_ATTEMPTS),
      ),
    )
    // Fewest attempts first, so a row that keeps failing falls behind the ones that haven't
    // been tried rather than holding the front of every batch.
    .orderBy(asc(listMemberships.confirmationAttempts), asc(listMemberships.createdAt))
    .limit(limit);
}

/**
 * Sends that a membership's confirmation gets before it stops being offered to the worker. An
 * address the provider refuses outright never becomes sendable, and without a ceiling it is
 * retried for the life of the row.
 */
export const MAX_CONFIRMATION_ATTEMPTS = 5;

/** Sends one membership's confirmation email and stamps `confirmationSentAt`. Never throws. */
export async function sendConfirmation(membershipId: string): Promise<void> {
  const context = await membershipContext(membershipId);
  if (!context) return;
  const { membership, listName, domainName, hasLayout, accent, confirmUrl } = context;
  if (membership.status !== "pending" || membership.confirmationSentAt) return;

  // Counted before anything that can throw, which is the whole point: signSubjectToken below
  // throws outright when BETTER_AUTH_SECRET is unset, and counting after it would leave the row
  // on zero attempts and back in the very next batch, forever. Every early return above this
  // line is a row that was never going to be sent, so none of them spend an attempt.
  await db
    .update(listMemberships)
    .set({ confirmationAttempts: sql`${listMemberships.confirmationAttempts} + 1`, updatedAt: await dbNow() })
    .where(eq(listMemberships.id, membership.id));

  const token = signSubjectToken(membership.id, "confirm");
  const link = confirmUrl ? `${confirmUrl}${confirmUrl.includes("?") ? "&" : "?"}token=${token}` : hostedConfirmUrl(token);
  const { html, text } = listConfirmationMail(listName, link, accent);

  try {
    const { message, replayed } = await acceptDashboardMessage(
      membership.organizationId,
      {
        from: `subscriptions@${domainName}`,
        to: [membership.address],
        subject: `Confirm your subscription to ${listName}`,
        html,
        text,
        layout: hasLayout,
        tags: ["list-confirmation"],
      },
      `list-confirm:${membership.id}`,
    );
    if (!replayed) await notifyQueued(message.id);
  } catch (err) {
    log.warn(`couldn't send confirmation for membership ${membership.id}: ${safeErrorMessage(err)}`);
    return;
  }

  const sentAt = await dbNow();
  await db
    .update(listMemberships)
    .set({ confirmationSentAt: sentAt, updatedAt: sentAt })
    .where(eq(listMemberships.id, membership.id));
}

/** What a confirmation link names, read without redeeming it. Null when the token is forged or its membership is gone. */
export type ConfirmLink = {
  state: "pending" | "subscribed" | "expired" | "unsubscribed";
  address: string;
  listName: string;
  domainId: string;
} | null;

export async function readConfirmToken(token: string): Promise<ConfirmLink> {
  const membershipId = verifySubjectToken(token, "confirm");
  if (!membershipId) return null;
  const context = await membershipContext(membershipId);
  if (!context) return null;
  const { membership, listName, domainId } = context;
  const base = { address: membership.address, listName, domainId };
  if (membership.status === "subscribed") return { state: "subscribed", ...base };
  if (membership.status === "unsubscribed") return { state: "unsubscribed", ...base };
  const now = await dbNow();
  if (membership.pendingExpiresAt && membership.pendingExpiresAt.getTime() < now.getTime()) return { state: "expired", ...base };
  return { state: "pending", ...base };
}

export interface ConfirmResult {
  list_id: string;
  address: string;
}

export class InvalidConfirmTokenError extends Error {
  constructor() {
    super("This confirmation link is invalid or has expired.");
    this.name = "InvalidConfirmTokenError";
  }
}

/**
 * Redeems a confirmation token: sets `subscribed` and `confirmed_at`, records the mode
 * (`link`), and emits `list.subscribed`. Idempotent — a link a scanner already followed, or a
 * person clicking twice, just finds the membership already confirmed.
 */
export async function redeemConfirmToken(token: string): Promise<ConfirmResult> {
  const membershipId = verifySubjectToken(token, "confirm");
  if (!membershipId) throw new InvalidConfirmTokenError();

  const context = await membershipContext(membershipId);
  if (!context) throw new InvalidConfirmTokenError();
  const { membership, domainId } = context;

  if (membership.status === "unsubscribed") throw new InvalidConfirmTokenError();

  if (membership.status === "pending") {
    const now = await dbNow();
    if (membership.pendingExpiresAt && membership.pendingExpiresAt.getTime() < now.getTime()) {
      throw new InvalidConfirmTokenError();
    }
    await db
      .update(listMemberships)
      .set({ status: "subscribed", confirmedAt: now, confirmedBy: "link", updatedAt: now })
      .where(eq(listMemberships.id, membership.id));

    await enqueueDomainScopedWebhookEvent(membership.organizationId, {
      eventId: newId("event"),
      eventType: "list.subscribed",
      occurredAt: now,
      domainId,
      data: { list_id: membership.listId, address: membership.address },
    }).catch(() => {});
  }

  return { list_id: membership.listId, address: membership.address };
}

/** The confirmation's body, framed by the domain's layout when it has one. Its accent colors the button. */
export function listConfirmationMail(listName: string, link: string, accent: string | null): { html: string; text: string } {
  const fill = accent && HEX_COLOR.test(accent) ? accent : PALETTE.light.foreground;
  const href = escapeHtml(link);
  const font = FONT_STACK.replace(/"/g, "'");
  const html = `<h1 style="margin:0 0 12px;font-family:${font};font-size:22px;line-height:1.3;font-weight:600">Confirm your subscription</h1>
<p style="margin:0 0 20px">Confirm that you want ${escapeHtml(listName)}. You won't get anything until you do.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="${fill}" style="border-radius:999px;background:${fill}"><a href="${href}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${font};font-size:16px;font-weight:600;line-height:20px;color:${textOn(fill)};text-decoration:none;border-radius:999px">Confirm subscription</a></td></tr></table>
<p style="margin:16px 0 0;font-size:13px;opacity:.75">Or open this link:<br><a href="${href}" target="_blank" style="word-break:break-all">${href}</a></p>
<p style="margin:16px 0 0;font-size:13px;opacity:.75">The link expires in 7 days. Didn't sign up? Ignore this email and you won't be added.</p>`;
  const text = [
    "Confirm your subscription",
    `Confirm that you want ${listName}. You won't get anything until you do.`,
    `Confirm subscription:\n${link}`,
    "The link expires in 7 days. Didn't sign up? Ignore this email and you won't be added.",
  ].join("\n\n");
  return { html, text };
}
