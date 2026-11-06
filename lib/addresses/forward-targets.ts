import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, eq, gt } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { addressForwardTargets, addresses, apiKeys, domains, organizations, providers, users, type AddressForwardTargetRow, type AddressRow } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { assertLiveKey, type OrganizationKeyRow } from "@/lib/api/keys";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { baseUrl } from "@/lib/api/urls";
import { isEmailAddress, normalizeAddress } from "@/lib/addresses";
import { SystemMailNotConfiguredError, sendSystemMail } from "@/lib/mail/system";
import { createElement } from "react";
import { SystemMail, type SystemMailBody } from "@/lib/mail/template";
import { signSubjectToken, verifySubjectToken } from "@/lib/lists/tokens";
import { inboundHost } from "@/lib/inbound/records";
import { capabilitiesOf } from "@/lib/providers/adapters";
import { newId } from "@/lib/ids";
import { requiresStrictDkim } from "./alignment";
import { addressInScope, type AddressCaller } from "./manage";
import { statusAt, type AddressDomain } from "./serialize";
import { disableTargets } from "./forward-disable";
import { FORWARD_CONFIRM_TTL_MS, FORWARD_PENDING_LIMIT, FORWARD_TARGET_LIMIT, type ForwardDisabledReason, type ForwardTargetStatus } from "./constants";

/** Confirmation mail one organization may send per minute. */
const CONFIRM_PER_ORGANIZATION = 10;
/** Confirmation mail one mailbox may be sent per minute, whoever asks. */
const CONFIRM_PER_EMAIL = 3;

export interface SerializedForwardTarget {
  id: string;
  address_id: string;
  email: string;
  status: ForwardTargetStatus;
  confirmation_sent_at: string | null;
  confirmation_expires_at: string | null;
  confirmed_at: string | null;
  disabled_at: string | null;
  disabled_reason: ForwardDisabledReason | null;
  forwarded_count: number;
  last_forwarded_at: string | null;
  last_failure: { code: string; message: string; at: string } | null;
  created_at: string;
  updated_at: string;
}

export function serializeForwardTarget(row: AddressForwardTargetRow): SerializedForwardTarget {
  return {
    id: row.id,
    address_id: row.addressId,
    email: row.email,
    status: row.status,
    confirmation_sent_at: row.confirmationSentAt?.toISOString() ?? null,
    confirmation_expires_at: row.status === "pending" ? (row.tokenExpiresAt?.toISOString() ?? null) : null,
    confirmed_at: row.confirmedAt?.toISOString() ?? null,
    disabled_at: row.disabledAt?.toISOString() ?? null,
    disabled_reason: row.disabledReason,
    forwarded_count: row.forwardedCount,
    last_forwarded_at: row.lastForwardedAt?.toISOString() ?? null,
    last_failure: row.lastFailure,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function forwardConfirmUrl(token: string): string {
  return `${baseUrl()}/forward/confirm/${token}`;
}

/** The stop link a forward carries. Signed over the target id; it doesn't expire. */
export function forwardStopUrl(targetId: string): string {
  return `${baseUrl()}/forward/stop/${signSubjectToken(targetId, "forward-stop")}`;
}

function callerFor(key: OrganizationKeyRow): AddressCaller {
  assertLiveKey(key, "manage forward targets");
  return { organizationId: key.organizationId, domainIds: key.domainIds, apiKeyId: key.id };
}

function tooMany(retryAfterMs: number): ApiError {
  const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new ApiError("rate_limit_exceeded", `Too many confirmation emails. Retry after ${retryAfter} seconds.`, {
    headers: { "Retry-After": String(retryAfter) },
  });
}

async function spendConfirmation(organizationId: string, email: string): Promise<void> {
  const byOrganization = await consumeRateLimit(`forward-confirm:organization:${organizationId}`, CONFIRM_PER_ORGANIZATION);
  if (byOrganization.exceeded) throw tooMany(byOrganization.retryAfterMs);
  const byEmail = await consumeRateLimit(`forward-confirm:email:${email.toLowerCase()}`, CONFIRM_PER_EMAIL);
  if (byEmail.exceeded) throw tooMany(byEmail.retryAfterMs);
}

/** Refuses what a forward from this address could never send: an inactive address, a provider that can't, or strict DKIM. */
export async function assertCanForward(addressRow: Pick<AddressRow, "status" | "expiresAt" | "domainId">, domain: AddressDomain, now: Date): Promise<void> {
  const status = statusAt(addressRow, now);
  if (status !== "active") {
    throw new ApiError("address_inactive", `This address is ${status} and can't forward.`, { detail: { status } });
  }
  const [provider] = await db
    .select({ adapter: providers.adapter })
    .from(domains)
    .innerJoin(providers, eq(providers.id, domains.providerId))
    .where(eq(domains.id, addressRow.domainId))
    .limit(1);
  const host = inboundHost(domain.name, domain.inboundSubdomain);
  if (!provider || !capabilitiesOf(provider.adapter).subdomainSending) {
    throw new ApiError("forward_not_allowed", `This domain's provider can't send from ${host}, so the address can't forward.`, {
      detail: { reason: "provider_incapable" },
    });
  }
  if (await requiresStrictDkim(host)) {
    throw new ApiError("forward_not_allowed", `The DMARC policy for ${host} sets adkim=s, which a forward signed for ${domain.name} fails. Relax it to adkim=r to forward.`, {
      detail: { reason: "strict_alignment" },
    });
  }
}

/** True when `email` is on any domain's inbound host on this install, which would loop mail between addresses. */
async function isInboundHost(email: string): Promise<boolean> {
  const host = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  const dot = host.indexOf(".");
  if (dot <= 0) return false;
  const [row] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.name, host.slice(dot + 1)), eq(domains.inboundSubdomain, host.slice(0, dot))))
    .limit(1);
  return Boolean(row);
}

/** Who's asking, on the email and the page alike: the person whose key made the address, else the organization. */
async function requesterFor(targetId: string): Promise<string> {
  const [row] = await db
    .select({ person: users.name, organization: organizations.name })
    .from(addressForwardTargets)
    .innerJoin(addresses, eq(addresses.id, addressForwardTargets.addressId))
    .innerJoin(organizations, eq(organizations.id, addressForwardTargets.organizationId))
    .leftJoin(apiKeys, eq(apiKeys.id, addresses.apiKeyId))
    .leftJoin(users, eq(users.id, apiKeys.createdBy))
    .where(eq(addressForwardTargets.id, targetId))
    .limit(1);
  return row?.person?.trim() || row?.organization || "An organization";
}

export function forwardConfirmationSubject(address: string): string {
  return `Confirm forwarding for ${address}`;
}

export function forwardConfirmationMail(input: { requester: string; address: string; email: string; url: string }): SystemMailBody {
  return {
    heading: "Forward this mail to you?",
    paragraphs: [
      `${input.requester} wants mail sent to ${input.address} forwarded to ${input.email}.`,
      "Nothing forwards until you confirm. Replies you send go straight to the sender, from your own mailbox.",
    ],
    action: { label: "Confirm forwarding", url: input.url },
    note: "The link expires in 7 days.",
    reason: `You got this because ${input.requester} added ${input.email} as a forward. Not expecting it? Ignore this email and nothing forwards.`,
  };
}

/** Sends the confirmation link from the system from address. */
async function mailConfirmation(target: AddressForwardTargetRow, address: string, token: string): Promise<void> {
  const requester = await requesterFor(target.id);
  try {
    await sendSystemMail({
      to: target.email,
      subject: forwardConfirmationSubject(address),
      email: createElement(SystemMail, forwardConfirmationMail({ requester, address, email: target.email, url: forwardConfirmUrl(token) })),
      tags: ["forward-confirmation"],
      withhold: "a forwarding confirmation link",
      idempotencyKey: `forward-confirm:${hashToken(token)}`,
    });
  } catch (error) {
    if (error instanceof SystemMailNotConfiguredError) throw new ApiError("provider_unavailable", error.message);
    throw error;
  }
}

async function issueToken(executor: Executor, targetId: string, now: Date): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await executor
    .update(addressForwardTargets)
    .set({ tokenHash: hashToken(token), tokenExpiresAt: new Date(now.getTime() + FORWARD_CONFIRM_TTL_MS), updatedAt: now })
    .where(eq(addressForwardTargets.id, targetId));
  return token;
}

async function stampSent(targetId: string): Promise<AddressForwardTargetRow> {
  const now = await dbNow();
  const [row] = await db
    .update(addressForwardTargets)
    .set({ confirmationSentAt: now, updatedAt: now })
    .where(eq(addressForwardTargets.id, targetId))
    .returning();
  return row!;
}

export async function addForwardTarget(key: OrganizationKeyRow, addressId: string, input: { email: string }): Promise<SerializedForwardTarget> {
  const caller = callerFor(key);
  const email = normalizeAddress(input.email);
  if (!isEmailAddress(email)) {
    throw new ApiError("validation_failed", `Field "email" isn't a valid address: ${input.email}.`, { field: "email" });
  }
  if (await isInboundHost(email)) {
    throw new ApiError("validation_failed", `${email} is on an inbound host. Forward to a mailbox, not another address.`, { field: "email" });
  }

  const { row: peek, domain } = await addressInScope(db, caller, addressId);
  await assertCanForward(peek, domain, await dbNow());
  const address = `${peek.localPart}@${inboundHost(domain.name, domain.inboundSubdomain)}`;

  const { target, token } = await db.transaction(async (tx) => {
    const now = await dbNow(tx);
    const { row } = await addressInScope(tx, caller, addressId, true);
    const held = await tx
      .select({ email: addressForwardTargets.email })
      .from(addressForwardTargets)
      .where(eq(addressForwardTargets.addressId, row.id));
    if (held.some((existing) => existing.email.toLowerCase() === email.toLowerCase())) {
      throw new ApiError("forward_target_exists", `${email} is already a forward target on this address.`, { field: "email" });
    }
    if (held.length >= FORWARD_TARGET_LIMIT) {
      throw new ApiError("forward_target_limit_reached", `This address has ${FORWARD_TARGET_LIMIT} forward targets, its limit. Remove one first.`, {
        detail: { limit: FORWARD_TARGET_LIMIT, scope: "address" },
      });
    }
    const [pending] = await tx
      .select({ total: count() })
      .from(addressForwardTargets)
      .where(and(eq(addressForwardTargets.organizationId, caller.organizationId), eq(addressForwardTargets.status, "pending"), gt(addressForwardTargets.tokenExpiresAt, now)));
    if ((pending?.total ?? 0) >= FORWARD_PENDING_LIMIT) {
      throw new ApiError(
        "forward_target_limit_reached",
        `This organization has ${FORWARD_PENDING_LIMIT} unconfirmed forward targets, its limit. Wait for one to confirm or remove one.`,
        { detail: { limit: FORWARD_PENDING_LIMIT, scope: "pending" } },
      );
    }
    const [inserted] = await tx
      .insert(addressForwardTargets)
      .values({ id: newId("forwardTarget"), organizationId: caller.organizationId, addressId: row.id, email, createdAt: now, updatedAt: now })
      .returning();
    return { target: inserted!, token: await issueToken(tx, inserted!.id, now) };
  });

  try {
    await spendConfirmation(caller.organizationId, email);
    await mailConfirmation(target, address, token);
  } catch (error) {
    await db.delete(addressForwardTargets).where(eq(addressForwardTargets.id, target.id));
    throw error;
  }
  return serializeForwardTarget(await stampSent(target.id));
}

async function targetInScope(caller: AddressCaller, addressId: string, targetId: string) {
  const { row: address, domain } = await addressInScope(db, caller, addressId);
  const [target] = await db
    .select()
    .from(addressForwardTargets)
    .where(and(eq(addressForwardTargets.addressId, address.id), eq(addressForwardTargets.id, targetId)))
    .limit(1);
  if (!target) throw new ApiError("not_found", `No forward target with id ${targetId} on this address.`);
  return { address, domain, target };
}

export async function listForwardTargets(key: OrganizationKeyRow, addressId: string): Promise<{ data: SerializedForwardTarget[]; next_cursor: null }> {
  return listForwardTargetsFor(callerFor(key), addressId);
}

/** The address's targets, oldest first, for any caller: a key or a dashboard session. */
export async function listForwardTargetsFor(caller: AddressCaller, addressId: string): Promise<{ data: SerializedForwardTarget[]; next_cursor: null }> {
  const { row } = await addressInScope(db, caller, addressId);
  const rows = await db
    .select()
    .from(addressForwardTargets)
    .where(eq(addressForwardTargets.addressId, row.id))
    .orderBy(asc(addressForwardTargets.createdAt), asc(addressForwardTargets.id));
  return { data: rows.map(serializeForwardTarget), next_cursor: null };
}

export async function readForwardTarget(key: OrganizationKeyRow, addressId: string, targetId: string): Promise<SerializedForwardTarget> {
  const { target } = await targetInScope(callerFor(key), addressId, targetId);
  return serializeForwardTarget(target);
}

/** Removing a target stops its forwards, queued ones included. */
export async function removeForwardTarget(key: OrganizationKeyRow, addressId: string, targetId: string): Promise<SerializedForwardTarget> {
  const { target } = await targetInScope(callerFor(key), addressId, targetId);
  await db.delete(addressForwardTargets).where(eq(addressForwardTargets.id, target.id));
  return serializeForwardTarget(target);
}

/** A new link for a target still waiting on its mailbox. The old link stops working. */
export async function resendForwardConfirmation(key: OrganizationKeyRow, addressId: string, targetId: string): Promise<SerializedForwardTarget> {
  const caller = callerFor(key);
  const { address, domain, target } = await targetInScope(caller, addressId, targetId);
  if (target.status !== "pending") {
    throw new ApiError("forward_target_not_pending", `This target is ${target.status}, so there's nothing to confirm.`, { detail: { status: target.status } });
  }
  await assertCanForward(address, domain, await dbNow());
  await spendConfirmation(caller.organizationId, target.email);
  const token = await issueToken(db, target.id, await dbNow());
  await mailConfirmation(target, `${address.localPart}@${inboundHost(domain.name, domain.inboundSubdomain)}`, token);
  return serializeForwardTarget(await stampSent(target.id));
}

export interface ForwardConsent {
  targetId: string;
  email: string;
  address: string;
  requester: string;
}

/** What a confirmation link names: a forward waiting on it, one it already confirmed, or nothing it can act on. */
export type ForwardLink = { state: "pending" | "confirmed"; consent: ForwardConsent } | null;

/** Reads a confirmation link. A confirmed target keeps its token hash, so a second visit says it's already on. */
export async function readForwardLink(token: string): Promise<ForwardLink> {
  if (!token || token.length > 200) return null;
  const [found] = await db
    .select({ target: addressForwardTargets, address: addresses, name: domains.name, inboundSubdomain: domains.inboundSubdomain })
    .from(addressForwardTargets)
    .innerJoin(addresses, eq(addresses.id, addressForwardTargets.addressId))
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .where(eq(addressForwardTargets.tokenHash, hashToken(token)))
    .limit(1);
  if (!found) return null;
  const now = await dbNow();
  if (statusAt(found.address, now) !== "active") return null;
  const consent = {
    targetId: found.target.id,
    email: found.target.email,
    address: `${found.address.localPart}@${inboundHost(found.name, found.inboundSubdomain)}`,
    requester: await requesterFor(found.target.id),
  };
  if (found.target.status === "confirmed") return { state: "confirmed", consent };
  if (found.target.status !== "pending") return null;
  if (!found.target.tokenExpiresAt || found.target.tokenExpiresAt.getTime() <= now.getTime()) return null;
  return { state: "pending", consent };
}

/** What a confirmation link names, while it's live and its address can still forward. */
export async function readForwardConfirmation(token: string): Promise<ForwardConsent | null> {
  const link = await readForwardLink(token);
  return link?.state === "pending" ? link.consent : null;
}

/** Confirms the target a live link names. Null when the link is forged, used, expired or its address can't forward. */
export async function confirmForwardTarget(token: string): Promise<ForwardConsent | null> {
  const consent = await readForwardConfirmation(token);
  if (!consent) return null;
  const now = await dbNow();
  const [row] = await db
    .update(addressForwardTargets)
    .set({ status: "confirmed", confirmedAt: now, tokenExpiresAt: null, updatedAt: now })
    .where(and(eq(addressForwardTargets.id, consent.targetId), eq(addressForwardTargets.status, "pending"), eq(addressForwardTargets.tokenHash, hashToken(token))))
    .returning({ id: addressForwardTargets.id });
  return row ? consent : null;
}

/** What a stop link names. */
export async function readForwardStop(token: string): Promise<{ targetId: string; email: string; address: string; status: ForwardTargetStatus } | null> {
  const targetId = verifySubjectToken(token, "forward-stop");
  if (!targetId) return null;
  const [found] = await db
    .select({ target: addressForwardTargets, localPart: addresses.localPart, name: domains.name, inboundSubdomain: domains.inboundSubdomain })
    .from(addressForwardTargets)
    .innerJoin(addresses, eq(addresses.id, addressForwardTargets.addressId))
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .where(eq(addressForwardTargets.id, targetId))
    .limit(1);
  if (!found) return null;
  return {
    targetId,
    email: found.target.email,
    address: `${found.localPart}@${inboundHost(found.name, found.inboundSubdomain)}`,
    status: found.target.status,
  };
}

/** The mailbox turns its own forwards off. Final: the address owner adds it again, and it confirms again. */
export async function stopForwardTarget(token: string): Promise<{ email: string; address: string } | null> {
  const found = await readForwardStop(token);
  if (!found) return null;
  await disableTargets(db, [found.targetId], "stopped");
  return { email: found.email, address: found.address };
}
