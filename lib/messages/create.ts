import { and, eq, inArray } from "drizzle-orm";
import { assertFeatureEnabled } from "@/lib/features";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, lists, messages, providers } from "@/lib/db/schema";
import type { MessageEnvelope, MessageRow } from "@/lib/db/schema";
import { domainOf, isEmailAddress, normalizeAddress, parseAddress } from "@/lib/addresses";
import { ApiError } from "@/lib/api/errors";
import type { KeyMode, OrganizationKeyRow } from "@/lib/api/keys";
import { keyCanAccessDomain } from "@/lib/api/keys";
import { newMessageKey, sha256 } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { capabilitiesOf } from "@/lib/providers/adapters";
import type { LayoutOverrides } from "@/lib/domains/layout";
import { RESERVED_HEADERS, type SendEmailRequest } from "@/lib/schemas/email";
import { SENSITIVE_HEADER } from "@/lib/wire";
import { htmlToText } from "./html-to-text";
import { base64Bytes, bodyBytes } from "./size";
import { checkFanout, renderedBodyHash } from "./bulk-detect";
import { logger } from "@/lib/logger";
import { indexMessages } from "@/lib/search";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { currentRequestId } from "@/lib/api/request-context";
import { newStorageKey, purgeBody, writeBody } from "@/lib/storage/bodies";
import { findSuppressed } from "./suppression";
import { touchFirstSeen, warningsFor } from "./history";
import { recordSuppressedRejection } from "@/lib/reputation/signals";
import { recordEvent } from "./events";
import { findByIdempotencyKey, hashRequest, outsideReplayWindow } from "./idempotency";
import { publishMessageUpdate } from "./updates";
import { addMembership } from "@/lib/lists/members";
import { assertNotSuspended } from "@/lib/suspension";
import { readSetting } from "@/lib/settings/values";

const log = logger.child("messages:create");

const UNIQUE_VIOLATION = "23505";

/** Drizzle wraps driver errors, so the Postgres code sits on the cause. */
function isUniqueViolation(err: unknown): boolean {
  const candidates = [err, (err as { cause?: unknown }).cause];
  return candidates.some((candidate) => (candidate as { code?: string } | undefined)?.code === UNIQUE_VIOLATION);
}

function collectAddresses(field: string, values: string[]): string[] {
  return values.map((value) => {
    const address = normalizeAddress(value);
    if (!isEmailAddress(address)) {
      throw new ApiError("validation_failed", `Field "${field}" contains an address that isn't valid: ${value}.`, {
        field,
      });
    }
    return address;
  });
}

/** Which field a recipient came from, so a suppression error names the field that's actually wrong. */
function fieldContaining(address: string, lists: { to: string[]; cc: string[]; bcc: string[] }): "to" | "cc" | "bcc" {
  if (lists.cc.includes(address)) return "cc";
  if (lists.bcc.includes(address)) return "bcc";
  return "to";
}

function assertHeadersAllowed(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === SENSITIVE_HEADER.toLowerCase()) {
      throw new ApiError("reserved_header", `Header "${name}" is read over SMTP only. Set "sensitive": true instead.`, {
        field: "headers",
      });
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new ApiError("reserved_header", `Header "${name}" is set by the service and can't be overridden.`, {
        field: "headers",
      });
    }
  }
}

/** `layout` is `true`, `false`, or an object of overrides — an object implies `true`. */
function layoutOverridesOf(request: SendEmailRequest): LayoutOverrides | null {
  return typeof request.layout === "object" && request.layout !== null ? request.layout : null;
}

/** Returns the decoded attachment bytes, which the row records. */
function assertAttachmentsFit(request: SendEmailRequest, providerAdapter: string): number {
  const limit = capabilitiesOf(providerAdapter).maxAttachmentBytes;
  const bytes = (request.attachments ?? []).reduce((total, attachment) => total + base64Bytes(attachment.content), 0);
  if (bytes > limit) {
    throw new ApiError("attachment_too_large", `Attachments exceed the ${Math.round(limit / (1024 * 1024))} MB limit for one message.`, {
      field: "attachments",
      detail: { limit_bytes: limit, size_bytes: bytes },
    });
  }
  return bytes;
}

/** Refuses a message over the install's size limit, body and attachments together. */
async function assertMessageFits(bodySize: number, attachmentBytes: number): Promise<void> {
  const limitMb = await readSetting("max_message_mb");
  const limit = limitMb * 1024 * 1024;
  const size = bodySize + attachmentBytes;
  if (size <= limit) return;
  throw new ApiError("attachment_too_large", `The message is over the ${limitMb} MB limit for one message, body and attachments together.`, {
    field: attachmentBytes > 0 ? "attachments" : "html",
    detail: { limit_bytes: limit, size_bytes: size },
  });
}

/** `domainId` names the domain outright, for an address on its inbound host. */
async function resolveDomain(organizationId: string, domainIds: string[], fromAddress: string, domainId?: string) {
  const name = domainOf(fromAddress);
  const [found] = await db
    .select({ domain: domains, providerAdapter: providers.adapter })
    .from(domains)
    .innerJoin(providers, eq(providers.id, domains.providerId))
    .where(and(eq(domains.organizationId, organizationId), domainId ? eq(domains.id, domainId) : eq(domains.name, name)))
    .limit(1);

  const domain = found?.domain;
  if (!domain || !found) {
    throw new ApiError("domain_not_verified", `Domain ${name} hasn't been added. Add it with POST /v1/domains.`, {
      field: "from",
      detail: { exists: false },
    });
  }
  if (!keyCanAccessDomain({ domainIds }, domain.id)) {
    throw new ApiError("key_not_scoped", `This key can't send from ${domain.name}.`, { field: "from" });
  }
  if (domain.status !== "verified") {
    throw new ApiError("domain_not_verified", `Domain ${domain.name} isn't verified. Add the listed DNS records and verify.`, {
      field: "from",
      detail: { records: domain.dnsRecords },
    });
  }
  return { domain, providerAdapter: found.providerAdapter };
}

export interface AcceptedMessage {
  message: MessageRow;
  /** True when an earlier request with the same idempotency key produced this row. */
  replayed: boolean;
}

function conflict(existing: MessageRow, windowExpired: boolean): ApiError {
  const message = windowExpired
    ? "This idempotency key is older than the 24-hour replay window. Send with a new key."
    : "This idempotency key was used with a different request body.";
  return new ApiError("idempotency_conflict", message, {
    detail: { message_id: existing.id, window_expired: windowExpired },
  });
}

/**
 * Returns the earlier message for a repeat. Throws when the body changed, when the key
 * belongs to a domain this key can't send from, or when the replay window has passed.
 */
function replay(domainIds: string[], existing: MessageRow, requestHash: string, now: Date): AcceptedMessage {
  if (!keyCanAccessDomain({ domainIds }, existing.domainId)) {
    throw new ApiError("key_not_scoped", "This key can't replay a message it didn't send.");
  }
  if (existing.requestHash !== requestHash) throw conflict(existing, false);
  if (outsideReplayWindow(existing, now)) throw conflict(existing, true);
  // A replay returns a message this request didn't create, so it needs its own line to correlate.
  log.info(`replayed ${existing.id} for organization ${existing.organizationId ?? "the service"}`);
  return { message: existing, replayed: true };
}

/**
 * Shared body for the key-authenticated API path and the dashboard's operator send.
 * `domainIds` carries scope: `acceptMessage` passes the real key scope; the dashboard
 * passes `[]` because a dashboard session reaches every domain in its organization.
 */
async function acceptInternal({
  organizationId,
  request,
  apiKeyId,
  mode,
  idempotencyKey,
  domainIds,
  fromDomainId,
  withheld,
  resentFrom,
  service = false,
  requestHash = hashRequest(request),
}: {
  /** The organization whose domain sends. With `service`, it carries the message without holding it. */
  organizationId: string;
  request: SendEmailRequest;
  apiKeyId: string | null;
  mode: KeyMode;
  idempotencyKey: string | null;
  domainIds: string[];
  fromDomainId?: string;
  withheld?: string;
  resentFrom?: string;
  /** Stores the message under no organization: the service's own mail. */
  service?: boolean;
  requestHash?: string;
}): Promise<AcceptedMessage> {
  const holderId = service ? null : organizationId;

  // Read once per operation and reused for both replay checks below, rather than a second
  // round trip on the unique-violation retry that could straddle the window boundary.
  let dbClockReading: Date | undefined;
  const replayNow = async (): Promise<Date> => (dbClockReading ??= await dbNow());

  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(holderId, idempotencyKey);
    if (existing) return replay(domainIds, existing, requestHash, await replayNow());
  }

  await assertNotSuspended(organizationId);

  const from = parseAddress(request.from);
  if (!from) {
    throw new ApiError("validation_failed", `Field "from" isn't a valid address.`, { field: "from" });
  }

  // Non-empty "to" and at least one of html/text are enforced by sendEmailSchema.
  const to = collectAddresses("to", request.to);
  const cc = collectAddresses("cc", request.cc ?? []);
  const bcc = collectAddresses("bcc", request.bcc ?? []);
  const replyTo = collectAddresses("reply_to", request.reply_to ?? []);

  const headers = request.headers ?? {};
  assertHeadersAllowed(headers);

  const { domain, providerAdapter } = await resolveDomain(organizationId, domainIds, from.address, fromDomainId);

  // Validated before the message commits — fail loudly rather than accept a send that named a
  // list it can't actually grow. Every named list must be on the sending domain.
  const subscribeListIds = request.subscribe ?? [];
  const subscribeListDoubleOptIn = new Map<string, boolean>();
  if (subscribeListIds.length > 0) {
    await assertFeatureEnabled("lists");
    const found = await db
      .select({ id: lists.id, doubleOptIn: lists.doubleOptIn })
      .from(lists)
      .where(and(eq(lists.organizationId, organizationId), eq(lists.domainId, domain.id), inArray(lists.id, subscribeListIds)));
    for (const row of found) subscribeListDoubleOptIn.set(row.id, row.doubleOptIn);
    const missing = subscribeListIds.find((id) => !subscribeListDoubleOptIn.has(id));
    if (missing) {
      throw new ApiError("validation_failed", `List ${missing} isn't on domain ${domain.name}.`, { field: "subscribe" });
    }
  }

  // An override adjusts a frame; it doesn't conjure one. A frame that doesn't exist is a
  // caller mistake either way, not a silent unframed send.
  if (request.layout && !domain.layout) {
    throw new ApiError("validation_failed", `Domain ${domain.name} has no layout.`, { field: "layout" });
  }
  const layoutOverrides = layoutOverridesOf(request);

  // Fail loudly rather than accept headers or attachments the domain's provider would drop.
  const headerNames = Object.keys(headers);
  if (headerNames.length > 0 && !capabilitiesOf(providerAdapter).customHeaders) {
    throw new ApiError("provider_limit", "This domain's provider doesn't carry custom headers.", {
      field: "headers",
      detail: { custom_headers: false, headers: headerNames },
    });
  }
  const recipientCount = to.length + cc.length + bcc.length;
  const maxRecipients = capabilitiesOf(providerAdapter).maxRecipients;
  if (recipientCount > maxRecipients) {
    throw new ApiError("provider_limit", `This domain's provider accepts at most ${maxRecipients} recipients per message.`, {
      field: "to",
      detail: { max_recipients: maxRecipients, recipients: recipientCount },
    });
  }
  const attachmentBytes = assertAttachmentsFit(request, providerAdapter);

  const recipients = [...new Set([...to, ...cc, ...bcc])];
  const suppressed = await findSuppressed(holderId, recipients);
  const first = suppressed[0];
  if (first) {
    await recordSuppressedRejection(organizationId, domain.id).catch((err: unknown) => {
      log.warn(`couldn't count a suppressed rejection: ${safeErrorMessage(err)}`);
    });
    const day = first.createdAt.toISOString().slice(0, 10);
    throw new ApiError("recipient_suppressed", `Recipient is suppressed: ${first.reason.replace("_", " ")} on ${day}.`, {
      field: fieldContaining(first.address, { to, cc, bcc }),
      detail: { address: first.address, reason: first.reason, suppressed_at: first.createdAt.toISOString() },
    });
  }

  // A warning never blocks: it's read here only to snapshot onto the message being accepted.
  const warnings = holderId === null ? [] : await warningsFor(holderId, recipients);

  const id = newId("message");
  const attachments = (request.attachments ?? []).map((attachment) => ({
    filename: attachment.filename,
    content: attachment.content,
    contentType: attachment.content_type,
  }));

  const html = request.html ?? null;
  // request.text is undefined when the caller sent no "text" at all, and "" when they
  // explicitly asked for html-only. Only the former derives a plain-text body from html.
  const textGenerated = request.text === undefined && html !== null;
  const text = request.text !== undefined ? request.text : textGenerated ? htmlToText(html) : null;

  const messageBodyBytes = bodyBytes(html, text);
  await assertMessageFits(messageBodyBytes, attachmentBytes);

  const bodyHash = renderedBodyHash(html, text, Boolean(request.layout), domain.layout, domain.name, layoutOverrides);

  // Fan-out is a property of the transactional path (a key), not of an operator's own send,
  // and test mode never reaches a real recipient — neither counts toward the ledger.
  if (apiKeyId && mode !== "test") {
    await checkFanout({
      organizationId,
      apiKeyId,
      bodyHash,
      recipients,
      headers,
      providerCarriesHeaders: capabilitiesOf(providerAdapter).customHeaders,
    });
  }

  const storageKey = newStorageKey();
  const { key: bodyKeyBuffer, encoded: bodyKeyEncoded } = newMessageKey();
  // The body goes first so no row is ever queued for a worker that can't read it. An insert
  // that never lands takes its object with it, below.
  await writeBody(bodyKeyBuffer, storageKey, { html, text, textGenerated, attachments });

  const envelope: MessageEnvelope = {
    from: from.address,
    fromName: from.name,
    to,
    cc,
    bcc,
    replyTo,
    headers,
    attachmentCount: attachments.length,
  };

  const values = {
    id,
    organizationId: holderId,
    domainId: domain.id,
    apiKeyId,
    status: "queued" as const,
    fromAddress: from.address,
    recipients,
    subject: request.subject,
    envelope,
    tags: request.tags ?? [],
    warnings,
    storageKey,
    bodyBytes: messageBodyBytes,
    attachmentBytes,
    bodyKey: bodyKeyEncoded,
    // A sender's mark carries no reason.
    bodyWithheld: withheld ?? (request.sensitive ? "" : null),
    resentFrom: resentFrom ?? null,
    testMode: mode === "test",
    layout: Boolean(request.layout),
    layoutOverrides,
    idempotencyKey,
    requestHash,
    bodyHash,
    requestId: currentRequestId() ?? null,
    // created_at and updated_at default to the database's now(); the app must not
    // override them with its own clock. See lib/db/clock.ts.
  };

  let row: MessageRow | undefined;
  try {
    [row] = await db.insert(messages).values(values).returning();
  } catch (err) {
    await purgeBody(storageKey).catch((purgeErr: unknown) => {
      log.warn(`couldn't purge the body of a message that wasn't inserted: ${safeErrorMessage(purgeErr)}`);
    });
    // A concurrent request won the same idempotency key. Its message is the answer to both.
    if (idempotencyKey && isUniqueViolation(err)) {
      const existing = await findByIdempotencyKey(holderId, idempotencyKey);
      if (existing) return replay(domainIds, existing, requestHash, await replayNow());
    }
    throw err;
  }

  if (!row) throw new ApiError("provider_unavailable", "The message couldn't be persisted.");

  // The one line that ties the caller's request id to the message id it produced. Counts only,
  // never an address or a subject.
  log.info(`accepted ${row.id} for ${holderId === null ? "the service" : `organization ${holderId}`} on domain ${domain.id} (${recipients.length} recipients)`);
  indexMessages([row], domain.name);

  // The message is committed. A failure recording its first event must not turn an
  // accepted send into an error response for a message the worker will still deliver.
  await recordEvent({ organizationId: holderId, messageId: row.id, status: "queued" }).catch((err: unknown) => {
    log.warn(`couldn't record the queued event for ${row.id}: ${safeErrorMessage(err)}`);
  });
  if (holderId !== null) {
    await touchFirstSeen(holderId, recipients).catch((err: unknown) => {
      log.warn(`couldn't record first-seen history for ${row.id}: ${safeErrorMessage(err)}`);
    });
  }
  await publishMessageUpdate(holderId, { messageId: row.id, status: "queued" });

  // Every list named in `subscribe` gets every `to` address, as an `api` membership carrying
  // this message's id — the only door a send can grow a list through. Best-effort: the message
  // is already committed and accepted, so a membership write failing here can't unsend it.
  for (const listId of subscribeListIds) {
    for (const address of to) {
      await addMembership({
        organizationId,
        listId,
        address,
        source: "api",
        doubleOptIn: subscribeListDoubleOptIn.get(listId) ?? true,
        sourceMessageId: row.id,
      }).catch((err: unknown) => {
        log.warn(`couldn't add ${row.id}'s recipient to list ${listId}: ${safeErrorMessage(err)}`);
      });
    }
  }

  return { message: row, replayed: false };
}

/**
 * Validates, checks suppression, stores the body and persists a queued message. `fromDomainId`
 * sends from an address on that domain's inbound host; the caller has checked the address.
 */
export async function acceptMessage(
  key: OrganizationKeyRow,
  request: SendEmailRequest,
  idempotencyKey: string | null,
  options: { fromDomainId?: string } = {},
): Promise<AcceptedMessage> {
  return acceptInternal({
    organizationId: key.organizationId,
    request,
    apiKeyId: key.id,
    mode: key.mode,
    idempotencyKey,
    domainIds: key.domainIds,
    fromDomainId: options.fromDomainId,
  });
}

/**
 * A new message copied from `original` and linked to it. An idempotent repeat replays before
 * `loadRequest` reads the body, and the request hash names the original, not its content.
 */
export async function acceptResend({
  organizationId,
  apiKeyId,
  mode,
  domainIds,
  original,
  idempotencyKey,
  loadRequest,
}: {
  organizationId: string;
  apiKeyId: string | null;
  mode: KeyMode;
  domainIds: string[];
  original: MessageRow;
  idempotencyKey: string | null;
  loadRequest: () => Promise<SendEmailRequest>;
}): Promise<AcceptedMessage> {
  const requestHash = sha256(`resend:${original.id}`);
  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(organizationId, idempotencyKey);
    if (existing) return replay(domainIds, existing, requestHash, await dbNow());
  }
  return acceptInternal({
    organizationId,
    request: await loadRequest(),
    apiKeyId,
    mode,
    idempotencyKey,
    domainIds,
    fromDomainId: original.domainId,
    resentFrom: original.id,
    requestHash,
  });
}

/** A forward of mail an address admitted, sent from the address and logged against the key that made it. */
export async function acceptForward(
  organizationId: string,
  apiKeyId: string | null,
  request: SendEmailRequest,
  idempotencyKey: string,
  fromDomainId: string,
): Promise<AcceptedMessage> {
  return acceptInternal({ organizationId, request, apiKeyId, mode: "live", idempotencyKey, domainIds: [], fromDomainId });
}

/**
 * The service's own mail, from a domain `organizationId` holds. That organization's provider,
 * suspension and stall carry it, and no organization's log, API or export holds it.
 */
export async function acceptServiceMessage(
  organizationId: string,
  request: SendEmailRequest,
  idempotencyKey: string,
  options: { withheld?: string } = {},
): Promise<AcceptedMessage> {
  return acceptInternal({
    organizationId,
    request,
    apiKeyId: null,
    mode: targetsMockOutcome(request.to) ? "test" : "live",
    idempotencyKey,
    domainIds: [],
    withheld: options.withheld,
    service: true,
  });
}

/** The magic local parts `lib/providers/adapters/mock.ts` resolves specially. */
const MOCK_LOCALS = new Set(["bounce", "defer", "slow"]);

function localPart(address: string): string {
  return address.split("@")[0]?.toLowerCase() ?? "";
}

/** True when a recipient's local part is one of the mock provider's magic addresses. */
function targetsMockOutcome(recipients: string[]): boolean {
  return recipients.some((address) => MOCK_LOCALS.has(localPart(address)));
}

/**
 * Operator-triggered send from the dashboard; no key, no scope check. Routes through test
 * mode — the mock provider, resolved by `TestModeLoop` instead of a real provider call —
 * when the recipient is one of the mock provider's magic addresses (`bounce@`, `defer@`,
 * `slow@`), so trying those outcomes never hits SES or Mailpace with a fake bounce. Any
 * other recipient keeps the real send, which is the point of a domain verification test.
 */
export async function acceptDashboardMessage(
  organizationId: string,
  request: SendEmailRequest,
  idempotencyKey: string | null = null,
  options: { withheld?: string } = {},
): Promise<AcceptedMessage> {
  const mode = targetsMockOutcome(request.to) ? "test" : "live";
  return acceptInternal({
    organizationId,
    request,
    apiKeyId: null,
    mode,
    idempotencyKey,
    domainIds: [],
    withheld: options.withheld,
  });
}