import type { z } from "zod";
import type { ErrorCode } from "@/lib/api/errors";
import { featureForPath } from "@/lib/features/registry";
import { adoptDomainSchema, createDomainSchema, listDomainsSchema, patchDomainSchema } from "@/lib/schemas/domain";
import { createExportSchema, listExportsSchema } from "@/lib/schemas/export";
import { sendEmailSchema } from "@/lib/schemas/email";
import { listEventsSchema } from "@/lib/schemas/event";
import { listInboundSchema, updateInboundSchema } from "@/lib/schemas/inbound";
import {
  addForwardTargetSchema,
  createAddressSchema,
  listAddressesSchema,
  listAddressMessagesSchema,
  replyFromAddressSchema,
  updateAddressSchema,
} from "@/lib/schemas/address";
import { listMessagesSchema, messageListShape } from "@/lib/schemas/message";
import {
  listProvidersSchema,
} from "@/lib/schemas/provider";
import {
  addMemberSchema,
  createListSchema,
  listListsSchema,
  listMembersSchema,
  unsubscribeAddressSchema,
  updateListSchema,
  updateMemberSchema,
} from "@/lib/schemas/list";
import { createBatchSchema } from "@/lib/schemas/batch";
import { importSuppressionsSchema, listSuppressionsSchema, SUPPRESSION_IMPORT_LIMIT } from "@/lib/schemas/suppression";
import { confirmSchema, unsubscribeRedeemSchema } from "@/lib/schemas/unsubscribe";
import { createKeySchema, listKeysSchema, updateKeySchema } from "@/lib/schemas/key";
import { readStatsSchema } from "@/lib/schemas/stats";
import { listDmarcReportsSchema } from "@/lib/schemas/dmarc";
import {
  createWebhookEndpointSchema,
  listWebhookDeliveriesSchema,
  listWebhookEndpointsSchema,
  updateWebhookEndpointSchema,
} from "@/lib/schemas/webhook-endpoint";
import { listActivitySchema } from "@/lib/schemas/activity";
import { ACTIVITY_ACTOR_TYPES, ACTIVITY_FAMILIES, ACTIVITY_OUTCOMES } from "@/lib/db/schema/activity";
import { WEBHOOK_DELIVERY_STATUSES } from "@/lib/db/schema/webhooks";
import { updateOrganizationSettingsSchema } from "@/lib/schemas/organization-settings";
import { createInvitationSchema, listInvitationsSchema } from "@/lib/schemas/invitation";
import {
  assignOrganizationSchema,
  createAdminProviderSchema,
  listProviderOrganizationsSchema,
  listAdminProvidersSchema,
  listAdminOrganizationsSchema,
  patchAdminProviderSchema,
  patchAdminOrganizationSchema,
  suspendOrganizationSchema,
  createAdminOrganizationSchema,
  listAdminUsersSchema,
  patchAdminUserSchema,
  listMembershipsSchema,
  patchMembershipSchema,
} from "@/lib/schemas/admin";
import { shapeQuerySchema } from "@/lib/api/shape";
import { type ApiField, fieldsFromSchema } from "./introspect";
import { shapeFor } from "./shapes";
import { brand } from "@/lib/brand";

/**
 * Every code the API returns, and when. Mirrors the `### Codes` table in
 * docs/api/conventions.md, which stays the source of truth — a new code lands here in the same
 * PR that adds it there. Keyed by the same ErrorCode type lib/api/errors.ts derives its status
 * codes from, so a typo'd or retired code in a route's `errors` list fails typecheck.
 */
export const CODES: Record<ErrorCode, { when: string }> = {
  invalid_json: { when: "The request body isn't parseable JSON." },
  invalid_key: {
    when: "The Authorization header is missing, malformed, unknown or revoked, or it's an admin key whose creator is no longer an admin.",
  },
  invalid_signature: { when: "A provider callback isn't signed with the key on file for the provider." },
  insufficient_role: {
    when: "A dashboard route or action was refused by the caller's organization role. Never returned under /v1.",
  },
  key_not_scoped: {
    when: "The key is valid but isn't scoped to the domain in from or the message being read, or it's limited to domains on a route that acts on the whole organization.",
  },
  admin_key_required: { when: "The route is under /v1/admin and the key doesn't have the admin scope." },
  organization_key_required: { when: "The route acts on an organization and the key is an admin key, which belongs to none." },
  admin_scope_not_allowed: {
    when: "An admin key can only be created by an admin, with no organization, live and with no domain limits.",
  },
  organization_suspended: {
    when: "The organization is suspended and can't send. detail carries source, reason and suspended_at.",
  },
  feature_disabled: {
    when: "An admin turned off the feature this route belongs to. detail.feature names it.",
  },
  not_found: { when: "No resource with that id in the key's organization, or no route at that path." },
  invalid_token: { when: "A confirm or unsubscribe token is malformed, forged or has expired." },
  method_not_allowed: {
    when: "The route exists but doesn't serve this method. Allow lists the ones it does.",
  },
  idempotency_conflict: {
    when: "The Idempotency-Key was already used with a different body, or is older than the 24-hour window.",
  },
  validation_failed: { when: "A field is missing or its value is the wrong shape. field names it." },
  recipient_suppressed: { when: "A recipient is on the suppression list." },
  domain_not_verified: { when: "The from domain isn't verified." },
  reserved_header: { when: "headers contains a header the service sets itself." },
  list_unsubscribe_required: {
    when: "This body has reached the fan-out threshold for the key and carries no List-Unsubscribe header.",
  },
  bulk_not_allowed: {
    when: "The domain's provider can't carry what bulk needs — List-Unsubscribe on /v1/emails past the fan-out threshold, or bulk at all on /v1/batches. Turning bulk_allowed on is also refused with detail.reason dmarc_required while the domain has no valid DMARC record.",
  },
  attachment_too_large: {
    when: "Attachments, the message or the request body itself exceed a size limit: the provider's attachment limit, or the install's max_message_mb for body and attachments together.",
  },
  provider_limit: { when: "The domain's provider can't do what the request asks." },
  domain_exists: { when: "The organization already has this domain." },
  domain_unavailable: { when: "The provider already holds this domain for someone else." },
  domain_not_at_provider: {
    when: "POST /v1/admin/domains was asked to adopt a domain the provider doesn't have. Add it instead.",
  },
  domain_in_use: { when: "The domain has messages, batches or lists and can't be deleted." },
  capability_unavailable: { when: "The provider can't do this through its API." },
  provider_exists: { when: "A provider with this name already exists in the organization it would belong to." },
  provider_in_use: { when: "The provider has domains bound to it and can't be deleted." },
  organization_in_use: {
    when: "The organization has mail waiting to send, or holds the domain the service sends its own mail from. detail.reason says which.",
  },
  provider_unassigned: { when: "The organization has no assigned provider, so a domain has nothing to send through." },
  credentials_rejected: { when: "New credentials failed the provider's own live check and weren't stored." },
  inbound_disabled: { when: "The domain doesn't accept mail, so an address on it would receive nothing. Enable inbound first." },
  address_exists: { when: "The domain already has an address with this local part, live or revoked." },
  address_limit_reached: { when: "The organization holds as many active addresses as its limit allows. detail carries the limit." },
  address_inactive: { when: "The address is expired or revoked, so it can't send or forward. detail.status says which." },
  reply_not_allowed: {
    when: "This reply would fail DMARC or answer a forged sender. detail.reason is sender_unverified, provider_incapable or strict_alignment.",
  },
  forward_not_allowed: {
    when: "A forward from this address would fail DMARC. detail.reason is provider_incapable or strict_alignment.",
  },
  forward_target_exists: { when: "The address already forwards to this mailbox, or is waiting on it to confirm." },
  forward_target_limit_reached: {
    when: "The address holds 5 forward targets, or the organization 20 unconfirmed ones. detail.scope says which.",
  },
  forward_target_not_pending: { when: "The target is already confirmed or disabled, so there's no confirmation to resend." },
  resend_not_allowed: {
    when: "The original can't be resent. detail.reason is withheld, shredded or expired when its body can't be read, or unsubscribed when a bulk original's recipient has unsubscribed from its domain since.",
  },
  storage_unavailable: { when: "Object storage didn't answer, so the original's body couldn't be read. Retry the request." },
  rate_limit_exceeded: { when: "The key's per-minute limit is spent. Retry-After says when to try again." },
  stream_limit_exceeded: { when: "This key already has the maximum number of streams open." },
  provider_unavailable: { when: "The service can't complete the request." },
};

/** Applies to every /v1 route regardless of method. */
export const GLOBAL_CODES: ErrorCode[] = ["invalid_key", "rate_limit_exceeded", "method_not_allowed"];

/** Applies to any route that reads a JSON body (POST here). */
export const BODY_CODES: ErrorCode[] = ["invalid_json", "attachment_too_large"];

export interface ResponseField {
  name: string;
  type: string;
  description: string;
}

export interface RouteSpec {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  auth: string;
  request?: { schemaName: string; schema: z.ZodType; fields: ApiField[]; note?: string };
  query?: { schemaName: string; schema: z.ZodType; fields: ApiField[] };
  response: { status: number; description: string; fields: ResponseField[]; note?: string };
  errors: ErrorCode[];
}

const DNS_RECORD_FIELDS: ResponseField[] = [
  { name: "type", type: "TXT | CNAME | MX", description: "DNS record type." },
  { name: "name", type: "string", description: "Record name to publish." },
  { name: "value", type: "string", description: "Record value to publish." },
  { name: "priority", type: "integer", description: "Set on MX records only." },
  {
    name: "merge",
    type: "spf",
    description: "Set when the name may already hold an SPF record. Add this record's mechanisms to that one rather than publishing a second.",
  },
];

const SETUP_STEP_FIELDS: ResponseField[] = [
  {
    name: "step",
    type: "domain | dns_records | verification | webhooks | credentials | removal",
    description: "Which part of setup this step is.",
  },
  { name: "message", type: "string", description: "What's left to do, and where." },
];

const PENDING_BINDING_FIELDS: ResponseField[] = [
  { name: "provider_id", type: "string", description: "The provider this domain is moving to." },
  { name: "dns_records", type: "same shape as the domain's dns_records", description: "Records the target provider asked for." },
  { name: "missing_records", type: "same shape as dns_records", description: "Records the target provider still can't see." },
  { name: "started_at", type: "string", description: "ISO 8601 timestamp the move was requested." },
];

const DMARC_FIELDS = [
  "status",
  "record_name",
  "source",
  "record",
  "policy",
  "subdomain_policy",
  "percent",
  "rua",
  "ruf",
  "adkim",
  "aspf",
  "alignment",
  "findings",
  "recommended",
];

const DMARC_RESPONSE_FIELD: ResponseField = {
  name: "dmarc",
  type: `{ ${DMARC_FIELDS.join(", ")} }`,
  description:
    "The domain's DMARC record, read live from DNS: its own, then its organizational domain's. status: found, missing, multiple (receivers ignore them all), invalid or unresolved (the lookup didn't answer). record_name, source (domain or organizational) and record say where it was read and what it says. policy, subdomain_policy, percent, rua, ruf, adkim and aspf are its tags, null or empty without a usable record. alignment: { dkim, spf, passes }, each with the domains the setup authenticates as, the mode and whether they align; passes when either does. findings: { kind, severity, message }, where severity problem needs a change and note doesn't. recommended: the record to publish at _dmarc.<domain>, the recommended one when there's no usable record, or the published one with the domain's report address added to rua; null when nothing needs to change. A missing record never blocks verification.",
};

const DMARC_REPORT_RECORD_FIELDS = ["source_ip", "count", "origin", "disposition", "dkim", "spf", "header_from", "envelope_from", "dkim_results", "spf_results"];

const DMARC_REPORT_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed dmr_." },
  { name: "domain_id", type: "string", description: "The domain the report is about." },
  { name: "reporter", type: "string", description: "The mailbox provider that sent it, as it names itself." },
  { name: "reporter_email", type: "string | null", description: "Where the reporter takes questions about the report." },
  { name: "report_id", type: "string", description: "The reporter's own id. Unique per domain and reporter." },
  { name: "begins_at", type: "string", description: "ISO 8601 start of the period the report covers." },
  { name: "ends_at", type: "string", description: "ISO 8601 end of the period. The list sorts on it, newest first." },
  { name: "policy", type: "{ domain, p, sp, pct, adkim, aspf }", description: "The DMARC policy the reporter found published." },
  { name: "message_count", type: "integer", description: "Messages the report counts for this domain." },
  { name: "received_at", type: "string", description: "ISO 8601 timestamp it arrived." },
  {
    name: "records",
    type: `{ ${DMARC_REPORT_RECORD_FIELDS.join(", ")} }[]`,
    description:
      "With include=records. One per source address, most messages first. origin: provider (signed with this domain's provider's DKIM key or sent from its envelope host), other (passed DMARC without the provider), forwarded (a DKIM signature for the domain broke on the way) or unauthenticated (failed DMARC with nothing of the domain's). dkim and spf are the receiver's aligned verdicts, pass or fail; dkim_results and spf_results are the raw checks.",
  },
];

const dmarcReportPageFields: ResponseField[] = [
  { name: "data", type: `{ ${DMARC_REPORT_RESPONSE_FIELDS.map((f) => f.name).join(", ")} }[]`, description: "The page of reports, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
  ...DMARC_REPORT_RESPONSE_FIELDS.map((field) => ({ ...field, name: `data[].${field.name}` })),
];

const STANDING_TYPE = "healthy | watch | at_risk | paused";

const DOMAIN_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed dom_." },
  { name: "name", type: "string", description: "The domain name." },
  { name: "status", type: "pending | verified | failed", description: "Lifecycle status." },
  { name: "dns_records", type: `{ ${DNS_RECORD_FIELDS.map((f) => f.name).join(", ")} }[]`, description: "The complete list to publish: DKIM for the domain, plus whatever else the provider needs and a recommended DMARC record at _dmarc.<domain> (required: false), carrying the domain's report address in rua once an admin has set up reports. A record marked merge joins one the name may already have." },
  { name: "missing_records", type: "same shape as dns_records", description: "Records the provider still can't see. Filled by a verify call. Never lists the DMARC record; dmarc reports it." },
  { name: "setup", type: `{ ${SETUP_STEP_FIELDS.map((f) => f.name).join(", ")} }[]`, description: "What the provider can't finish through its API. A step in the provider's console reads as waiting on an admin; a webhooks step on a provider that wires its own events clears with a verify call." },
  { name: "errors", type: "string[]", description: "Provider reasons for a failed status. Empty once verification succeeds." },
  { name: "verified_at", type: "string | null", description: "ISO 8601 timestamp, or null." },
  { name: "last_checked_at", type: "string | null", description: "ISO 8601 timestamp of the last verify check, or null." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
  { name: "provider_id", type: "string", description: "The provider this domain sends through now, prefixed pac_. A move changes it once the target verifies." },
  {
    name: "pending",
    type: `{ ${PENDING_BINDING_FIELDS.map((f) => f.name).join(", ")} } | null`,
    description: "A move to another provider in progress, started by PATCH. Null when there isn't one.",
  },
  {
    name: "stall",
    type: "{ reason, message, stalled_at } | null",
    description: "Sending is held on this domain: sends are still accepted, queued ones wait until a person clears the hold. Null when sending normally.",
  },
  {
    name: "bulk_allowed",
    type: "boolean",
    description: "Whether this domain may send bulk batches (POST /v1/batches). Off by default; set with PATCH.",
  },
  {
    name: "layout",
    type: "{ name, logo, accent, footer } | null",
    description: "The frame a send with layout: true is wrapped in, and what a send's layout overrides fall back to. Null when there isn't one; set with PATCH.",
  },
  {
    name: "standing",
    type: STANDING_TYPE,
    description: "Reputation standing over the last 7 days. paused means sending from the domain is paused.",
  },
  { name: "standing_reason", type: "string | null", description: "One sentence on why the domain isn't healthy. Null when it is." },
];

const DOMAIN_REPUTATION_FIELDS = [
  "findings",
  "windows",
  "reasons",
  "signals",
  "blocklists",
  "provider_findings",
  "tenant_volume",
];

const DOMAIN_READ_RESPONSE_FIELDS: ResponseField[] = [
  ...DOMAIN_RESPONSE_FIELDS,
  { ...DMARC_RESPONSE_FIELD, type: `${DMARC_RESPONSE_FIELD.type} | undefined`, description: `With include=dmarc. ${DMARC_RESPONSE_FIELD.description}` },
  {
    name: "reputation",
    type: `{ ${DOMAIN_REPUTATION_FIELDS.join(", ")} } | null`,
    description:
      "With include=reputation. findings: every finding behind the standing, worst first. windows: 7 and 30 days, each metric's count, denominator, rate, previous_rate and delta against watch_line, at_risk_line, stall_line, provider_review_line and provider_pause_line. reasons: the receiving servers' words for recent bounces and complaints. signals: the last 24 hours against the 7 days before, or null. blocklists: state (on, off or paused), each list's answer and listed link domains. provider_findings: open SES findings on the organization's tenant. tenant_volume: SES's own counts for the tenant, or null. Null until the domain has verified.",
  },
];

const FINDING_FIELDS = ["kind", "standing", "title", "body", "action"];

const REPUTATION_RESPONSE_FIELDS: ResponseField[] = [
  { name: "object", type: "reputation", description: "Always reputation, the same object the reputation_changed webhooks carry." },
  { name: "subject", type: "{ type, id, name }", description: "The organization: type is organization, id is prefixed org_." },
  { name: "standing", type: STANDING_TYPE, description: "The organization's standing: its own findings, or its worst domain, with a paused domain counting as at_risk. paused means the organization is suspended." },
  { name: "reason", type: "string | null", description: "One sentence on why the organization isn't healthy. Null when it is." },
  { name: "findings", type: `{ ${FINDING_FIELDS.join(", ")} }[]`, description: "The organization's own findings, worst first. Domain findings are on each domain." },
  { name: "domains", type: "{ id, name, standing }[]", description: "Domains that aren't healthy, worst first. Empty when every domain is healthy." },
];

const STATUS_COUNT_FIELDS = "{ total, queued, sent, deferred, delivered, bounced, complained, failed, abandoned }";
const LATENCY_FIELDS = "{ p50_ms, p95_ms, p99_ms, count }";

const STATS_RESPONSE_FIELDS: ResponseField[] = [
  {
    name: "window",
    type: "{ since, until, previous_since, previous_until, bucket }",
    description: "What was counted: messages accepted from since until until, against previous_since until previous_until. bucket is hour or day, in UTC; the first bucket starts at the hour or day since falls in.",
  },
  { name: "mode", type: "live | test | all", description: "Which mail was counted." },
  {
    name: "counts",
    type: STATUS_COUNT_FIELDS,
    description: "Messages accepted in the window, by the status they have now. abandoned is the part of sent the provider never reported on. With status, only those statuses count.",
  },
  { name: "previous_counts", type: STATUS_COUNT_FIELDS, description: "The same for the window before." },
  { name: "attempts", type: "{ per_send, previous_per_send }", description: "Attempts per message that reached the provider, this window and the one before. Null with none." },
  { name: "buckets", type: `({ start } & ${STATUS_COUNT_FIELDS})[]`, description: "The counts per bucket, oldest first, empty buckets included." },
  { name: "previous_buckets", type: `({ start } & ${STATUS_COUNT_FIELDS})[]`, description: "With include=previous_buckets. The window before, aligned with buckets by index." },
  {
    name: "latency",
    type: `{ queue, provider, end_to_end }, each ${LATENCY_FIELDS}`,
    description: "With include=latency. Accepted to handed over, handed over to delivered and accepted to delivered, in milliseconds. Read from hourly histograms, so within 2.2% of the exact value. Null quantiles with no samples.",
  },
  {
    name: "domains",
    type: `{ domain_id, name, counts, previous_total, queue_p95_ms, last_sent_at, buckets }[]`,
    description: "With include=domains. Every domain with mail in this window or the one before, busiest first. buckets holds totals aligned with buckets.",
  },
  { name: "keys", type: "{ key_id, total, buckets }[]", description: "With include=keys. Every key that sent in the window, busiest first; key_id is null for mail sent without one." },
  { name: "reasons", type: "{ reason, count }[]", description: "With include=reasons. The receiving servers' words for bounces and complaints on this window's messages, verbatim, most common first, at most 20." },
  {
    name: "queue",
    type: "{ queued, due, backing_off, held, in_progress, silent, oldest_queued_at, oldest_due_at, oldest_held_at, held_by_domain, organization_held, organization_fails }",
    description: "With include=queue. The queue right now, whatever the window. held is what GET /v1/emails?held=true lists. silent was handed over between an hour and a day ago with no word back.",
  },
  { name: "inbound", type: "{ total, buckets }", description: "With include=inbound. Mail received in the window, with totals aligned with buckets. A test key gets key_not_scoped." },
  {
    name: "domain_days",
    type: "{ domain_id, day, computed_at, delivered_count, delivery_ms, hourly_volume }[]",
    description: "With include=domain_days. One row per domain per UTC day in the window: delivery_ms holds min, p10, p25, p50, p75, p90, p99 and max of sent to delivered over the 7 days before computed_at; hourly_volume holds sends by UTC hour of day over the 28 days before. Live mail only.",
  },
];

const WARNING_FIELDS: ResponseField[] = [
  { name: "code", type: "previously_bounced | previously_complained | frequent_deferrals", description: "Stable identifier for the kind of history." },
  { name: "address", type: "string", description: "The recipient this warning is about." },
  { name: "message", type: "string", description: "One sentence, in the same voice as an error message." },
  { name: "detail", type: "object", description: "Counts and timestamps behind the warning." },
];

const MESSAGE_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed msg_." },
  { name: "url", type: "string", description: "Where this message can be read at." },
  { name: "status", type: "queued | sent | delivered | deferred | bounced | complained | failed", description: "Lifecycle status." },
  { name: "from", type: "string", description: "Sender, as Name <address> when a name was given." },
  { name: "to", type: "string[]", description: "Recipient addresses." },
  { name: "cc", type: "string[]", description: "Carbon-copy addresses." },
  { name: "bcc", type: "string[]", description: "Blind carbon-copy addresses." },
  { name: "reply_to", type: "string[]", description: "Reply-to addresses." },
  { name: "subject", type: "string", description: "Subject line." },
  { name: "tags", type: "string[]", description: "Tags as sent." },
  { name: "headers", type: "object", description: "Custom headers as accepted. Empty when the send had none." },
  {
    name: "layout",
    type: "boolean | { name, logo, accent, footer }",
    description: "As the send asked for it: false, true for the domain's layout as configured, or the fields it overrode for this send.",
  },
  { name: "key_id", type: "string | null", description: "The key that sent it, prefixed key_. Null for mail sent without a key, from the dashboard or by the service itself." },
  { name: "batch_id", type: "string | null", description: "The batch it was sent in, prefixed bat_. Null for a single send." },
  { name: "test_mode", type: "boolean", description: "Whether the sending key was test-mode." },
  {
    name: "sensitive",
    type: "boolean",
    description: "Whether the body is withheld from every read: the send set sensitive, or the message carried a credential.",
  },
  {
    name: "warnings",
    type: `{ ${WARNING_FIELDS.map((f) => f.name).join(", ")} }[]`,
    description: "Hints from the recipient's send history, as they stood when this message was accepted. Empty when there's nothing worth flagging. Never changes whether the message was accepted.",
  },
  { name: "provider_message_id", type: "string | null", description: "The provider's own id for the message, once sent." },
  { name: "reason", type: "string | null", description: "The provider's reason for the current status, when there is one." },
  { name: "attempts", type: "integer", description: "Delivery attempts made so far." },
  {
    name: "next_attempt_at",
    type: "string | null",
    description: "When the service next tries to send it, as an ISO 8601 timestamp. Null unless status is queued. A time in the past means it's due now.",
  },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
  { name: "sent_at", type: "string | null", description: "ISO 8601 timestamp, or null." },
  { name: "delivered_at", type: "string | null", description: "ISO 8601 timestamp, or null." },
  {
    name: "abandoned_at",
    type: "string | null",
    description: "When the service stopped waiting on a sent message the provider never reported back on. status stays sent. Null otherwise.",
  },
  {
    name: "size",
    type: "{ body_bytes, attachment_bytes }",
    description:
      "Bytes as accepted. body_bytes is the UTF-8 size of the html and text parts before the domain's layout, attachment_bytes the decoded size of the attachments, 0 with none. Each is null on a message accepted before sizes were recorded.",
  },
  { name: "resent_from", type: "string | null", description: "The message this one was resent from, prefixed msg_. Null for an original send." },
  {
    name: "resends",
    type: "{ id, status, created_at }[]",
    description: "The copies resent from this message, oldest first. Returned by GET /v1/emails/:id, and by the list with include=resends.",
  },
  {
    name: "events",
    type: "{ id, status, reason, occurred_at }[]",
    description: "Every lifecycle transition, oldest first. Returned by GET /v1/emails/:id, and by the list with include=events.",
  },
  {
    name: "occurrences",
    type: "{ id, kind, reason, occurred_at, detail }[]",
    description:
      "With include=occurrences. What happened without changing the status, oldest first. kind is retry ({ attempt, next_attempt_at }), backoff ({ until, count }), suppressed ({ address, suppression_reason }), body_shredded ({ retention_days }), webhook_delivered ({ event_type, host, status_code }) or abandoned ({}).",
  },
  {
    name: "stall",
    type: "{ kind, reason, message, stalled_at } | null",
    description: "Returned by GET /v1/emails/:id only. Null unless status is queued and held. `kind` is \"domain\" when the message's own domain is paused, or \"organization\" when its organization is suspended for reputation or by the provider. `reason` is provider_paused under a provider suspension. `reason`, `message` and `stalled_at` otherwise match a domain response's stall field.",
  },
  {
    name: "body",
    type: "{ html, text, attachments: { filename, content_type, size, download_url }[] } | null",
    description: "With include=body. html as accepted, before the domain's layout wraps it. Each download_url is a signed link valid for 15 minutes, minted on every read. Null when the body can't be read, and body_unavailable says why.",
  },
  {
    name: "rendered",
    type: "{ html, framed, frame_changed } | null",
    description:
      "With include=rendered. html is the html part as the recipient got it, framed in the domain's layout when the send asked for one. frame_changed is true when the layout or its template changed after the message was accepted, so the frame isn't the one sent, and null when that can't be told. Null when the body can't be read, and body_unavailable says why.",
  },
  {
    name: "body_unavailable",
    type: "{ reason, message, ended_at } | null",
    description: "With include=body or include=rendered. Null when body is there. reason is withheld (the message is sensitive and its body is never returned), shredded (past retention, key destroyed), expired (past retention) or unavailable (storage didn't answer; read again). ended_at is when the body stopped being readable, or null.",
  },
];

/** A message without its expansions: what a webhook, a stream frame and a send response carry. */
const MESSAGE_BASE_FIELDS = MESSAGE_RESPONSE_FIELDS.filter((f) => (messageListShape.defaults as readonly string[]).includes(f.name));

const STREAM_FRAME_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed evt_. Sent as the frame's SSE id — echo it back as a Last-Event-ID header to resume after a disconnect." },
  {
    name: "type",
    type: "email.queued | email.sent | email.delivered | email.deferred | email.bounced | email.complained | email.failed",
    description: "The transition this frame reports. Also sent as the frame's SSE event name. The three delivered/bounced/complained values match the webhook event of the same name.",
  },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp the transition happened." },
  { name: "data", type: `{ ${MESSAGE_BASE_FIELDS.map((f) => f.name).join(", ")} }`, description: "The message, in the same shape GET /v1/emails/:id returns — and the same shape a webhook posts." },
];

const DELETE_DOMAIN_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "The deleted domain's id." },
  { name: "deleted", type: "true", description: "Always true — the route errors instead of returning false." },
];

const domainPageFields: ResponseField[] = [
  { name: "data", type: "Domain[]", description: "The page of domains, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const messagePageFields: ResponseField[] = [
  { name: "data", type: "Message[]", description: "The page of messages, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const INBOUND_ATTACHMENT_FIELDS: ResponseField[] = [
  { name: "filename", type: "string", description: "As sent." },
  { name: "content_type", type: "string", description: "As sent." },
  { name: "size", type: "integer", description: "Decoded size, in bytes." },
  { name: "quarantined", type: "boolean", description: "True when the message failed the provider's virus scan. Its content wasn't kept." },
  {
    name: "download_url",
    type: "string | null",
    description: "A signed link to the content, valid for 15 minutes and minted on every read. Null in a webhook payload, where you read the message for one, and when quarantined.",
  },
];

const INBOUND_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed inb_." },
  { name: "url", type: "string", description: "Where this message can be read at." },
  { name: "domain_id", type: "string", description: "The domain this mail was received on." },
  { name: "from", type: "string", description: "Sender, as Name <address> when a name was given." },
  { name: "to", type: "string[]", description: "Recipients the provider delivered this to." },
  { name: "subject", type: "string", description: "Subject line." },
  { name: "text", type: "string | null", description: "Plain-text body, when the sender included one. Part of the body expansion: a fields list without text or html skips reading it." },
  { name: "html", type: "string | null", description: "HTML body, when the sender included one. Part of the body expansion, with text." },
  { name: "headers", type: "object", description: "Headers as the provider forwarded them." },
  { name: "message_id", type: "string | null", description: "The sender's Message-Id header, verbatim." },
  { name: "in_reply_to", type: "string | null", description: "The sender's In-Reply-To header, verbatim." },
  {
    name: "outbound_message_id",
    type: "string | null",
    description: "Set when in_reply_to matches a message this organization sent. Threading is metadata only — nothing here lets you reply.",
  },
  {
    name: "attachments",
    type: `{ ${INBOUND_ATTACHMENT_FIELDS.map((f) => f.name).join(", ")} }[]`,
    description: "Content isn't inlined; each attachment's download_url fetches it.",
  },
  {
    name: "raw_download_url",
    type: "string | null",
    description: "A signed link to the message as received (message/rfc822), valid for 15 minutes. Null in a webhook payload, when the provider didn't hand the original over, and when the message failed a virus scan.",
  },
  {
    name: "verdicts",
    type: "{ spam, virus, spf, dkim, dmarc } | null",
    description: "The provider's scan results, each pass, fail, gray, processing_failed or null. Null when the provider doesn't scan. Check spf, dkim and dmarc before trusting from.",
  },
  { name: "address_ids", type: "string[]", description: "Addresses this message was delivered to, prefixed adr_. Empty for mail no address took." },
  {
    name: "thread_id",
    type: "string",
    description: "Opaque id, prefixed thr_, shared by every message linked to this one through Message-ID, In-Reply-To or References.",
  },
  { name: "received_at", type: "string", description: "ISO 8601 timestamp." },
  { name: "expires_at", type: "string", description: "ISO 8601 timestamp this message is purged at, row and attachments together." },
];

/** `GET /v1/inbound/:id`: an inbound message, plus its webhook delivery on request. */
const INBOUND_READ_RESPONSE_FIELDS: ResponseField[] = [
  ...INBOUND_RESPONSE_FIELDS,
  {
    name: "delivery",
    type: "WebhookDelivery | null",
    description:
      "With include=delivery. The newest delivery to the domain's inbound webhook, in the shape GET /v1/webhook_endpoints/:id/deliveries returns, without payload. Null when none was queued.",
  },
];

const ADDRESS_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed adr_." },
  { name: "address", type: "string", description: "The full address: <local_part>@<the domain's inbound host>." },
  { name: "domain_id", type: "string", description: "The domain it lives on." },
  { name: "local_part", type: "string", description: "The part before the @, lowercased." },
  { name: "label", type: "string | null", description: "Your note, or null." },
  { name: "status", type: "active | expired | revoked", description: "active delivers. expired and revoked drop mail silently and count it. Only revoked is final." },
  { name: "expires_at", type: "string", description: "ISO 8601 timestamp the address stops delivering." },
  { name: "message_cap", type: "integer | null", description: "Most messages it delivers over its life, or null for no cap." },
  { name: "key_id", type: "string | null", description: "The key that created it. That key's endpoints subscribed to address.received hear its mail." },
  {
    name: "counts",
    type: "{ received, received_today, dropped_expired, dropped_over_limit, dropped_virus, forwarded }",
    description:
      "Messages delivered, over its life and on the current UTC day, and messages dropped after expiry or revocation, past the cap or the daily limit, or for failing a virus scan. forwarded counts copies sent on to forward targets.",
  },
  { name: "last_received_at", type: "string | null", description: "ISO 8601 timestamp of the last delivered message, or null." },
  { name: "revoked_at", type: "string | null", description: "ISO 8601 timestamp, or null." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
  { name: "updated_at", type: "string", description: "ISO 8601 timestamp." },
];

const FORWARD_TARGET_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed fwt_." },
  { name: "address_id", type: "string", description: "The address it forwards from." },
  { name: "email", type: "string", description: "The mailbox it forwards to." },
  { name: "status", type: "pending | confirmed | disabled", description: "Only confirmed targets receive forwards." },
  { name: "confirmation_sent_at", type: "string | null", description: "ISO 8601 timestamp the last confirmation link went out." },
  { name: "confirmation_expires_at", type: "string | null", description: "When the live confirmation link stops working. Null unless pending." },
  { name: "confirmed_at", type: "string | null", description: "ISO 8601 timestamp, or null." },
  { name: "disabled_at", type: "string | null", description: "ISO 8601 timestamp, or null." },
  {
    name: "disabled_reason",
    type: "bounced | complained | stopped | null",
    description: "Why forwarding stopped: a forward hard-bounced, the mailbox marked one as spam or it used the stop link.",
  },
  { name: "forwarded_count", type: "integer", description: "Forwards sent to it." },
  { name: "last_forwarded_at", type: "string | null", description: "ISO 8601 timestamp, or null." },
  {
    name: "last_failure",
    type: "{ code, message, at } | null",
    description: "The last forward the send path refused, such as recipient_suppressed, with its error code and message.",
  },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
  { name: "updated_at", type: "string", description: "ISO 8601 timestamp." },
];

const forwardTargetPageFields: ResponseField[] = [
  { name: "data", type: "ForwardTarget[]", description: "Every target on the address, oldest first." },
  { name: "next_cursor", type: "null", description: "Always null: an address holds at most 5 targets." },
];

const addressPageFields: ResponseField[] = [
  { name: "data", type: "Address[]", description: "The page of addresses, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const inboundPageFields: ResponseField[] = [
  { name: "data", type: "InboundMessage[]", description: "The page of inbound mail, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const DNS_RECORD_TYPE_FIELDS = DNS_RECORD_FIELDS.map((f) => f.name).join(", ");

const INBOUND_STATUS_RESPONSE_FIELDS: ResponseField[] = [
  { name: "domain_id", type: "string", description: "The domain this status is for." },
  { name: "enabled", type: "boolean", description: "Whether this domain accepts mail." },
  { name: "retention_days", type: "integer", description: "7 default, up to the install's ceiling: 30 unless an admin changed it." },
  { name: "subdomain", type: "string", description: "The label mail is addressed to. inbound by default." },
  { name: "host", type: "string", description: "The host mail is addressed to, <subdomain>.<domain>: reply@<host>." },
  { name: "webhook_url", type: "string | null", description: "Where inbound.received is delivered. Null until one is registered." },
  {
    name: "receiver_url",
    type: "string | null",
    description: `Where this domain's provider should be told to POST inbound mail — a manual step in the provider's console for an adapter without an inbound API. Null when ${brand.name} routes the provider's mail itself.`,
  },
  { name: "dns_records", type: `{ ${DNS_RECORD_TYPE_FIELDS} }[]`, description: "Includes the provider's inbound record once enabled, alongside the domain's send records." },
  {
    name: "webhook_secret",
    type: "string",
    description: "Present only the moment a webhook URL is (re)registered — shown once, like any endpoint secret.",
  },
];

const PROVIDER_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed pac_." },
  { name: "adapter", type: "string", description: "Provider adapter: ses, mailpace, cloudflare or mock. Capabilities such as bulk, custom headers and inbound follow it." },
  { name: "name", type: "string", description: "Label for this provider." },
  { name: "assigned", type: "boolean", description: "True for the organization's assigned provider, which a new domain binds to by default." },
  { name: "status", type: "ready | setting_up | paused | unavailable", description: "Whether the organization can send through this provider. setting_up means its first domain is still being set up at the provider." },
  { name: "backoff_until", type: "string | null", description: "ISO 8601 timestamp the worker skips this provider until, or null." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
  { name: "updated_at", type: "string", description: "ISO 8601 timestamp." },
];

const providerPageFields: ResponseField[] = [
  { name: "data", type: "Provider[]", description: "The page of providers, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const EXPORT_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed exp_." },
  { name: "kind", type: "log_csv | log_ndjson | bodies | data", description: "What this export contains." },
  {
    name: "status",
    type: "requested | running | ready | failed | expired",
    description: "requested and running are both in progress. ready carries download_url. failed carries error. expired means the artifact's retention window (7 days from ready_at) has passed — request a new export.",
  },
  { name: "count", type: "integer | null", description: "Row count as of the request." },
  { name: "filename", type: "string | null", description: "Set once the export is ready." },
  {
    name: "download_url",
    type: "string | null",
    description: "A signed link to the artifact, minted fresh on every read. Present only while status is ready — request the export again to re-read this field for a current link.",
  },
  { name: "error", type: "string | null", description: "Set only when status is failed." },
  { name: "requested_at", type: "string", description: "ISO 8601 timestamp." },
  { name: "started_at", type: "string | null", description: "ISO 8601 timestamp the worker began building this export, or null." },
  { name: "ready_at", type: "string | null", description: "ISO 8601 timestamp, or null." },
  { name: "failed_at", type: "string | null", description: "ISO 8601 timestamp, or null." },
  { name: "expires_at", type: "string | null", description: "ISO 8601 timestamp the artifact is deleted, or null before it's ready." },
];

const exportPageFields: ResponseField[] = [
  { name: "data", type: "Export[]", description: "The page of exports, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const LIST_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed lst_." },
  { name: "domain_id", type: "string", description: "The domain this list belongs to." },
  { name: "name", type: "string", description: "List name, unique per domain." },
  { name: "double_opt_in", type: "boolean", description: "Whether a new membership must confirm before it can receive a batch." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
  { name: "updated_at", type: "string", description: "ISO 8601 timestamp." },
];

/** A list as the reads return it: include=member_counts adds the counts. */
const LIST_READ_FIELDS: ResponseField[] = [
  ...LIST_RESPONSE_FIELDS,
  {
    name: "member_counts",
    type: "{ pending, subscribed, unsubscribed }",
    description: "With include=member_counts. Members of the list by status, counted on read.",
  },
];

const listPageFields: ResponseField[] = [
  { name: "data", type: "List[]", description: "The page of lists, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const DELETE_LIST_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "The deleted list's id." },
  { name: "deleted", type: "true", description: "Always true — the route errors instead of returning false." },
];

const MEMBERSHIP_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed lmb_." },
  { name: "list_id", type: "string", description: "The list this membership belongs to." },
  { name: "address", type: "string", description: "Normalized recipient address." },
  { name: "status", type: "pending | subscribed | unsubscribed", description: "Whether this address currently receives a batch." },
  { name: "source", type: "api | import | manual", description: "How this membership was created." },
  { name: "source_message_id", type: "string | null", description: "Set when source is api — the send whose subscribe added this member." },
  { name: "manual_actor", type: "string | null", description: "Set when source is manual — who added the member." },
  { name: "attributes", type: "object", description: "Flat map substituted into {{name}} placeholders on a batch send." },
  { name: "double_opt_in", type: "boolean", description: "The opt-in mode that applied to this membership." },
  { name: "confirmed_at", type: "string | null", description: "ISO 8601 timestamp, or null." },
  { name: "confirmed_by", type: "link | import | not_required | null", description: "Which mode confirmed this membership." },
  { name: "pending_expires_at", type: "string | null", description: "A pending membership past this timestamp never receives a batch." },
  { name: "unsubscribed_at", type: "string | null", description: "ISO 8601 timestamp, or null." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
  { name: "updated_at", type: "string", description: "ISO 8601 timestamp." },
];

const membershipPageFields: ResponseField[] = [
  { name: "data", type: "Membership[]", description: "The page of members, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const REMOVE_MEMBER_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "The removed membership's id." },
  { name: "removed", type: "true", description: "Always true — the route errors instead of returning false." },
];

const UNSUBSCRIBE_RESPONSE_FIELDS: ResponseField[] = [{ name: "address", type: "string", description: "The address unsubscribed." }];

const UNSUBSCRIBE_REDEEM_RESPONSE_FIELDS: ResponseField[] = [
  { name: "scope", type: "list | domain", description: "Which scope the token was redeemed at." },
  { name: "list_name", type: "string | null", description: "Set when scope is list." },
  { name: "domain_name", type: "string", description: "The domain the list (or the stop-all-mail choice) belongs to." },
];

const CONFIRM_RESPONSE_FIELDS: ResponseField[] = [
  { name: "list_id", type: "string", description: "The list this membership was confirmed on." },
  { name: "address", type: "string", description: "The confirmed address." },
];

const BATCH_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed bat_." },
  { name: "domain_id", type: "string", description: "The sending domain." },
  { name: "list_id", type: "string | null", description: "Set when recipients were drawn from a list. Null for inline recipients." },
  { name: "from", type: "string", description: "Sender, as Name <address> when a name was given." },
  { name: "subject", type: "string", description: "Subject line, before {{name}} substitution." },
  { name: "tags", type: "string[]", description: "Tags as sent." },
  { name: "recipient_count", type: "integer", description: "Recipients that became a message." },
  { name: "skipped_count", type: "integer", description: "Recipients skipped: unsubscribed, not yet confirmed or suppressed." },
  { name: "counts", type: "object", description: "The batch's messages, tallied by lifecycle status. Live — reread for a current picture." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
];

const SUPPRESSION_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed sup_." },
  { name: "address", type: "string", description: "Normalized address: domain part lowercased, local part kept." },
  { name: "reason", type: "hard_bounce | complaint | manual", description: "Why sends to it fail." },
  { name: "detail", type: "string | null", description: "The provider's reason verbatim, or the note or detail it was added with." },
  { name: "bounce_type", type: "string | null", description: "The provider's bounce classification, such as Permanent/NoEmail. Null for complaints, manual adds, imports and providers that don't classify." },
  { name: "source", type: "string | null", description: "Where an imported suppression came from. Null for a bounce, complaint or single add." },
  { name: "source_message_id", type: "string | null", description: "The message that bounced or complained, when there was one." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
];

const RECIPIENT_MESSAGE_FIELDS = "{ id, subject, domain_id, status, test_mode, created_at }";

const RECIPIENT_RESPONSE_FIELDS: ResponseField[] = [
  { name: "address", type: "string", description: "Normalized address: domain part lowercased, local part kept." },
  { name: "first_seen_at", type: "string | null", description: "When a message to it was first accepted. Null for an address only suppressed or unsubscribed." },
  { name: "last_sent_at", type: "string | null", description: "When the newest message to it was accepted." },
  { name: "last_status", type: "string | null", description: "The newest message's status." },
  { name: "domain_ids", type: "string[]", description: "Domains that have sent to it." },
  {
    name: "messages",
    type: "{ total, delivered, bounced, complained, failed }",
    description: "Messages addressed to it, test mode included, counted by status. The rest are still in flight. List them with GET /v1/emails and to.",
  },
  { name: "bounce_count", type: "integer", description: "Bounce events naming this address." },
  { name: "complaint_count", type: "integer", description: "Complaint events naming this address." },
  { name: "last_delivered_at", type: "string | null", description: "The newest delivery event's timestamp." },
  { name: "last_bounced_at", type: "string | null", description: "The newest bounce event's timestamp." },
  { name: "last_complained_at", type: "string | null", description: "The newest complaint event's timestamp." },
  {
    name: "suppression",
    type: `{ ${[...SUPPRESSION_RESPONSE_FIELDS.map((f) => f.name), "added_by", "source_message"].join(", ")} } | null`,
    description: `The suppression a send to it fails on, or null. added_by names who added it by hand. source_message is ${RECIPIENT_MESSAGE_FIELDS} for the message that bounced or complained, or null.`,
  },
  {
    name: "unsubscribes",
    type: "{ lists: { list_id, unsubscribed_at }[], domains: { domain_id, unsubscribed_at }[] }",
    description: "Lists it unsubscribed from, and domains it stopped outright.",
  },
  { name: "history", type: `${RECIPIENT_MESSAGE_FIELDS}[]`, description: "With include=history. The latest 50 messages to it, newest first." },
  { name: "incidents", type: `${RECIPIENT_MESSAGE_FIELDS}[]`, description: "With include=history. The latest 50 that bounced or complained, newest first." },
];

const REMOVE_SUPPRESSION_RESPONSE_FIELDS: ResponseField[] = [
  { name: "address", type: "string", description: "The address removed, in its normalized form." },
  { name: "removed", type: "true", description: "Always true — the route errors instead of returning false." },
];

const SUPPRESSION_IMPORT_FIELDS: ResponseField[] = [
  { name: "added", type: "integer", description: "Rows added to the list." },
  { name: "already_present", type: "integer", description: "Rows already on the list, or repeated earlier in this request. Their existing row is left as it was." },
  { name: "invalid", type: "integer", description: "Rows skipped because they couldn't be read. Equals the length of errors." },
  { name: "errors", type: "{ line, address, message }[]", description: "One entry per invalid row. line is the file's line for a CSV body and null for JSON." },
];

const ADMIN_PROVIDER_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed pac_." },
  { name: "adapter", type: "string", description: "Provider adapter: ses, mailpace, cloudflare or mock." },
  { name: "name", type: "string", description: "Label for this provider." },
  { name: "kind", type: "shared | single", description: "shared serves every assigned organization, each isolated at the provider. single serves the one organization it lives in." },
  { name: "organization_id", type: "string | null", description: "The organization a single provider serves. Null for a shared one." },
  { name: "organization_count", type: "integer", description: "Organizations assigned this provider." },
  { name: "default_for_new_organizations", type: "boolean", description: "Whether new organizations are assigned this provider." },
  { name: "identity", type: "string | null", description: "The provider's own provider id, such as the AWS account number. Null until the health check reads it." },
  { name: "settings", type: "object", description: "Non-secret provider config. Never credentials." },
  { name: "concurrency", type: "integer", description: "Concurrent sends allowed." },
  { name: "backoff_until", type: "string | null", description: "ISO 8601 timestamp the worker skips this provider until, or null." },
  {
    name: "status",
    type: "ready | converting | needs_conversion | credentials_failing | backing_off | setting_up | quota",
    description: "ready, or the most urgent entry in issues. converting replaces needs_conversion while a conversion runs.",
  },
  {
    name: "issues",
    type: "string[]",
    description: "Everything that needs attention, most urgent first: needs_conversion, credentials_failing, backing_off, setting_up, quota (80% of the daily quota).",
  },
  { name: "health", type: "object", description: "The last check: ok (boolean or null), detail and checked_at." },
  { name: "conversion", type: "object | null", description: "The latest conversion run, as GET /v1/admin/providers/:id/convert returns it." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
  { name: "updated_at", type: "string", description: "ISO 8601 timestamp." },
];

const ADMIN_PROVIDER_WRITE_FIELDS: ResponseField[] = [
  ...ADMIN_PROVIDER_FIELDS,
  {
    name: "credentials_verified",
    type: "boolean | null",
    description: "Present when the write stored credentials. true means the live check passed; null means the adapter can't check itself.",
  },
];

const adminProviderPageFields: ResponseField[] = [
  { name: "data", type: "AdminProvider[]", description: "The page of providers, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const ASSIGNMENT_FIELDS: ResponseField[] = [
  { name: "organization_id", type: "string", description: "The assigned organization." },
  { name: "organization_name", type: "string", description: "Its name." },
  { name: "provider_id", type: "string", description: "The row the organization's domains bind to: its own row on a shared provider, or the provider itself." },
  { name: "default", type: "boolean", description: "Whether it's the organization's default provider." },
  { name: "domain_count", type: "integer", description: "Domains bound to it." },
  { name: "status", type: "ready | setting_up | paused", description: "setting_up means a domain was added and the setup at the provider isn't finished yet." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
];

const assignmentPageFields: ResponseField[] = [
  { name: "data", type: "Assignment[]", description: "The page of assignments, newest first." },
  { name: "next_cursor", type: "string | null", description: "provider_id to pass as cursor for the next page. Null on the last page." },
];

const ADMIN_ORGANIZATION_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed org_." },
  { name: "name", type: "string", description: "Display name." },
  { name: "slug", type: "string", description: "URL slug." },
  { name: "provider_id", type: "string | null", description: "The assignment new domains bind to, or null when nothing is assigned." },
  { name: "managed_provider_id", type: "string | null", description: "The provider an admin manages it on: the shared provider for a shared row, else the row itself." },
  { name: "assignment_count", type: "integer", description: "Providers the organization's domains can bind to." },
  { name: "domain_count", type: "integer", description: "Domains in the organization." },
  { name: "suspension", type: "object | null", description: "source, reason and suspended_at while suspended, otherwise null." },
  { name: "address_limit", type: "integer", description: "Active addresses the organization may hold: its override, else the install's default." },
  { name: "address_daily_message_limit", type: "integer", description: "Messages one address may receive per UTC day: its override, else the install's default." },
  { name: "address_limit_override", type: "integer | null", description: "The organization's own address limit. Null follows the install's default." },
  { name: "address_daily_message_limit_override", type: "integer | null", description: "The organization's own daily limit. Null follows the install's default." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
  { name: "updated_at", type: "string", description: "ISO 8601 timestamp." },
];

const adminOrganizationPageFields: ResponseField[] = [
  { name: "data", type: "AdminOrganization[]", description: "The page of organizations, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const ADMIN_ORGANIZATION_CHANGE_FIELDS: ResponseField[] = [
  ...ADMIN_ORGANIZATION_FIELDS,
  { name: "changed", type: "boolean", description: "False when the organization was already in the requested state." },
];

const CONVERSION_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "The provider being converted. It keeps this id afterwards." },
  {
    name: "plan",
    type: "object",
    description: "parent_id, parent_name, configuration_set_name, identities, permissions, stages (stage, done, calls) and converted.",
  },
  {
    name: "conversion",
    type: "object | null",
    description: "The latest run: state (running, done or failed), started_at, heartbeat_at, finished_at, reached, stopped_at, error, missing_permissions and interrupted. Null before the first run.",
  },
];

const KEY_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed key_." },
  { name: "name", type: "string", description: "Name the key was created with." },
  { name: "mode", type: "live | test", description: "test routes every send to the mock provider." },
  { name: "secret_prefix", type: "string", description: "Leading characters of the secret, enough to tell two keys apart. Never the secret." },
  { name: "domain_ids", type: "string[]", description: "Domains the key may send from. Empty means every domain in the organization." },
  { name: "rate_limit", type: "integer", description: "Requests a minute this key is allowed." },
  {
    name: "last_used_at",
    type: "string | null",
    description:
      "ISO 8601 timestamp of the last request that authenticated with it, over HTTP or SMTP, written at most once a minute. Null until the key's first request.",
  },
  { name: "revoked_at", type: "string | null", description: "ISO 8601 timestamp, or null while the key works." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
];

const MINTED_KEY_RESPONSE_FIELDS: ResponseField[] = [
  ...KEY_RESPONSE_FIELDS,
  { name: "secret", type: "string", description: "The full key. Returned by this call only — it's stored as a hash and can't be read back." },
];

const keyPageFields: ResponseField[] = [
  { name: "data", type: "Key[]", description: "The page of keys, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const WEBHOOK_ENDPOINT_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed whk_." },
  { name: "key_id", type: "string", description: "The key whose sends produce this endpoint's events." },
  { name: "url", type: "string", description: `Where ${brand.name} posts.` },
  { name: "events", type: "string[]", description: "Events this endpoint receives." },
  { name: "description", type: "string | null", description: "The note it was created with, or null." },
  { name: "disabled", type: "boolean", description: "True while delivery is stopped, by request or by too many exhausted deliveries." },
  { name: "last_success_at", type: "string | null", description: "ISO 8601 timestamp of the last 2xx, or null." },
  { name: "last_failure_at", type: "string | null", description: "ISO 8601 timestamp of the last failed attempt, or null." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
];

const WEBHOOK_ENDPOINT_SECRET_FIELDS: ResponseField[] = [
  ...WEBHOOK_ENDPOINT_RESPONSE_FIELDS,
  { name: "secret", type: "string", description: "The signing secret, returned by this call only. Reveal it again on the key detail screen, or rotate for a new one." },
];

const webhookEndpointPageFields: ResponseField[] = [
  { name: "data", type: "WebhookEndpoint[]", description: "The page of endpoints, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const WEBHOOK_ATTEMPT_FIELDS = ["id", "attempt", "status_code", "error", "duration_ms", "created_at"];

const WEBHOOK_DELIVERY_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed whd_. The X-Webhook-Id header carries it." },
  { name: "endpoint_id", type: "string", description: "The endpoint it was posted to." },
  { name: "event_type", type: "string", description: "The X-Webhook-Event it carries." },
  { name: "status", type: WEBHOOK_DELIVERY_STATUSES.join(" | "), description: "pending while attempts remain, succeeded on a 2xx, exhausted once retrying stops. failed is reserved and not written." },
  { name: "attempt_count", type: "integer", description: "Attempts made so far." },
  { name: "last_status_code", type: "integer | null", description: "The receiver's last HTTP status, or null when it never answered." },
  { name: "last_error", type: "string | null", description: "Why the last attempt failed without a status, such as a timeout." },
  { name: "next_attempt_at", type: "string | null", description: "When the next attempt is due. Null unless pending." },
  { name: "succeeded_at", type: "string | null", description: "ISO 8601 timestamp of the 2xx, or null." },
  { name: "expires_at", type: "string", description: "When retrying stops: 24 hours after the delivery was queued." },
  { name: "message_id", type: "string | null", description: "The sent message the event is about, or null for an event with no single message." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp of when it was queued." },
  {
    name: "payload",
    type: "object",
    description:
      "The body that was posted, frozen at enqueue: a retry sends the same one. In the default on a single read, with include=payload on the list. An address.received body loses text and html when the message is purged.",
  },
  {
    name: "attempts",
    type: `{ ${WEBHOOK_ATTEMPT_FIELDS.join(", ")} }[]`,
    description: "Each attempt, oldest first: the status code or error and how long it took. In the default on a single read, with include=attempts on the list.",
  },
];

const webhookDeliveryPageFields: ResponseField[] = [
  { name: "data", type: "WebhookDelivery[]", description: "The page of deliveries, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const ACTIVITY_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed act_." },
  { name: "action", type: "string", description: "What happened, as subject.verb: domain.added, key.revoked, webhook.endpoint.created." },
  { name: "family", type: ACTIVITY_FAMILIES.join(" | "), description: "The kind of thing acted on." },
  { name: "outcome", type: ACTIVITY_OUTCOMES.join(" | "), description: "Whether it worked." },
  {
    name: "actor",
    type: "{ type, id, label }",
    description: `Who did it. type is ${ACTIVITY_ACTOR_TYPES.join(", ")}. id is null for the worker. label is the name when it happened.`,
  },
  { name: "applies_to", type: "string | null", description: "The subject's id, its type implied by the action. Null for an organization-wide action." },
  { name: "subject_label", type: "string | null", description: "The subject's name when it happened. A suppression's address while the suppression exists." },
  { name: "address", type: "string | null", description: "A list member's address while the membership or domain stop exists, else null." },
  { name: "metadata", type: "object | null", description: "What changed, by action: from and to, counts, reasons, the key behind a webhook endpoint." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
];

const activityPageFields: ResponseField[] = [
  { name: "data", type: "Activity[]", description: "The page of entries, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const ORGANIZATION_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed org_." },
  { name: "name", type: "string", description: "Display name." },
  { name: "slug", type: "string", description: "URL slug. Read-only here; it addresses dashboard screens." },
  { name: "body_retention_days", type: "integer", description: "Days a message body stays readable before the worker shreds its key." },
  {
    name: "body_retention_max_days",
    type: "integer",
    description: "The install's ceiling on body_retention_days. Bodies stay readable for the smaller of the two.",
  },
  { name: "address_limit", type: "integer", description: "Active addresses the organization may hold. Set by an admin." },
  { name: "address_daily_message_limit", type: "integer", description: "Messages one address may receive per UTC day. Set by an admin." },
  { name: "suspended", type: "boolean", description: "True while the organization can't send. An admin releases it." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
  { name: "updated_at", type: "string", description: "ISO 8601 timestamp." },
  {
    name: "address_counts",
    type: "{ active, expired, revoked }",
    description: "With include=address_counts. The organization's addresses by status, counted on read. active is what address_limit caps.",
  },
];

const OPERATOR_MEMBERSHIP_FIELDS = ["organization_id", "organization_name", "role"];

const ACCOUNT_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "The account's id." },
  { name: "name", type: "string", description: "Display name." },
  { name: "email", type: "string", description: "Email address, which is also how they sign in." },
  { name: "admin", type: "boolean", description: "The service-wide admin flag. Orthogonal to any organization role." },
  {
    name: "memberships",
    type: `{ ${OPERATOR_MEMBERSHIP_FIELDS.join(", ")} }[]`,
    description: "Organizations this account belongs to, oldest first, with its role in each.",
  },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
];

const accountPageFields: ResponseField[] = [
  { name: "data", type: "Account[]", description: "The page of accounts, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const DELETED_ACCOUNT_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "The deleted account." },
  { name: "email", type: "string", description: "Its address, as it stood before the delete." },
  { name: "deleted", type: "boolean", description: "Always true." },
];

const MEMBER_RESPONSE_FIELDS: ResponseField[] = [
  { name: "user_id", type: "string", description: "The account's id." },
  { name: "name", type: "string", description: "Display name." },
  { name: "email", type: "string", description: "Email address." },
  { name: "role", type: "owner | member", description: "What they may do inside this organization." },
  { name: "admin", type: "boolean", description: "Whether they also hold the service-wide admin flag." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp the membership was created." },
];

const memberPageFields: ResponseField[] = [
  { name: "data", type: "Member[]", description: "The page of members, oldest first." },
  { name: "next_cursor", type: "string | null", description: "user_id to pass as cursor for the next page. Null on the last page." },
];

const REMOVED_MEMBER_FIELDS: ResponseField[] = [
  { name: "user_id", type: "string", description: "The account removed from the organization." },
  { name: "organization_id", type: "string", description: "The organization." },
  { name: "removed", type: "boolean", description: "Always true. The account and the keys it created are untouched." },
];

const INVITATION_RESPONSE_FIELDS: ResponseField[] = [
  { name: "id", type: "string", description: "Opaque id, prefixed inv_." },
  { name: "email", type: "string", description: "The invited address, normalized." },
  { name: "role", type: "owner | member", description: "The role this invitation grants in the organization." },
  {
    name: "status",
    type: "pending | accepted | revoked | expired",
    description: "expired is a pending invitation past expires_at; the stored status is only ever the other three.",
  },
  { name: "invited_by", type: "string | null", description: "The account that sent it, or null once that account is gone." },
  { name: "expires_at", type: "string", description: "ISO 8601 timestamp the token stops working." },
  { name: "accepted_at", type: "string | null", description: "ISO 8601 timestamp it was redeemed, or null." },
  { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
];

const invitationPageFields: ResponseField[] = [
  { name: "data", type: "Invitation[]", description: "The page of invitations, newest first." },
  { name: "next_cursor", type: "string | null", description: "Id to pass as cursor for the next page. Null on the last page." },
];

const ADMIN = "Admin key";
const ADMIN_ERRORS: ErrorCode[] = ["admin_key_required"];

const DECLARED_ROUTES: RouteSpec[] = [
  {
    method: "POST",
    path: "/v1/domains",
    summary: "Add a domain",
    auth: "Bearer key with no domain scope",
    request: { schemaName: "createDomainSchema", schema: createDomainSchema, fields: fieldsFromSchema(createDomainSchema, "createDomainSchema") },
    response: {
      status: 201,
      description: "The created domain, with the DNS records to publish.",
      fields: DOMAIN_RESPONSE_FIELDS,
    },
    errors: ["validation_failed", "key_not_scoped", "not_found", "provider_unassigned", "capability_unavailable", "domain_exists", "domain_unavailable", "provider_unavailable"],
  },
  {
    method: "GET",
    path: "/v1/domains",
    summary: "List domains",
    auth: "Bearer key",
    query: { schemaName: "listDomainsSchema", schema: listDomainsSchema, fields: fieldsFromSchema(listDomainsSchema, "listDomainsSchema") },
    response: {
      status: 200,
      description: "A page of the key's domains, newest first.",
      fields: domainPageFields,
    },
    errors: ["validation_failed"],
  },
  {
    method: "GET",
    path: "/v1/domains/:id",
    summary: "Read a domain",
    auth: "Bearer key scoped to the domain",
    response: { status: 200, description: "The domain.", fields: DOMAIN_READ_RESPONSE_FIELDS },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "PATCH",
    path: "/v1/domains/:id",
    summary: "Update a domain",
    auth: "Bearer key scoped to the domain",
    request: {
      schemaName: "patchDomainSchema",
      schema: patchDomainSchema,
      fields: fieldsFromSchema(patchDomainSchema, "patchDomainSchema"),
      note: "provider_id records a pending move; the domain keeps sending on its current provider until it verifies, and null cancels a move in progress. bulk_allowed turns bulk sending on or off; turning it on is refused when the provider can't do bulk at all, and while the domain has no valid DMARC record. layout sets the frame: fields left out keep their stored value, a domain without a layout needs name, accent and footer, and null removes it. Layout applies first, so a layout that fails validation changes nothing.",
    },
    response: {
      status: 200,
      description: "The domain, with pending set to the new binding's records when a move started.",
      fields: DOMAIN_RESPONSE_FIELDS,
    },
    errors: ["validation_failed", "not_found", "key_not_scoped", "capability_unavailable", "bulk_not_allowed", "domain_unavailable", "provider_unavailable"],
  },
  {
    method: "DELETE",
    path: "/v1/domains/:id",
    summary: "Remove a domain",
    auth: "Bearer key scoped to the domain",
    response: {
      status: 200,
      description: "Confirms removal.",
      fields: DELETE_DOMAIN_RESPONSE_FIELDS,
      note: "Refuses a domain that has sent messages. Keeps the domain when the provider can't remove it.",
    },
    errors: ["not_found", "key_not_scoped", "domain_in_use", "provider_unavailable"],
  },
  {
    method: "POST",
    path: "/v1/domains/:id/verify",
    summary: "Check verification",
    auth: "Bearer key scoped to the domain",
    response: {
      status: 200,
      description: "The domain with missing_records refreshed against the provider's current answer, and dmarc read live.",
      fields: [...DOMAIN_RESPONSE_FIELDS, DMARC_RESPONSE_FIELD],
    },
    errors: ["not_found", "key_not_scoped", "capability_unavailable"],
  },
  {
    method: "GET",
    path: "/v1/domains/:id/inbound",
    summary: "Read inbound status",
    auth: "Bearer key scoped to the domain",
    response: { status: 200, description: "Whether inbound is enabled, its retention window and its webhook.", fields: INBOUND_STATUS_RESPONSE_FIELDS.filter((f) => f.name !== "webhook_secret") },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "PATCH",
    path: "/v1/domains/:id/inbound",
    summary: "Enable, disable or reconfigure inbound",
    auth: "Bearer key scoped to the domain",
    request: {
      schemaName: "updateInboundSchema",
      schema: updateInboundSchema,
      fields: fieldsFromSchema(updateInboundSchema, "updateInboundSchema"),
      note: "webhook_url is required the first time inbound is enabled on a domain. Enabling adds the provider's own inbound DNS record to dns_records, on a subdomain (inbound.<domain> by default, or subdomain) so the domain's own mailbox is untouched. On SES, enabling also creates the receipt rule that routes the subdomain's mail; the provider needs an inbound bucket first.",
    },
    response: { status: 200, description: "The domain's inbound status. webhook_secret is present only when a webhook URL was just (re)registered.", fields: INBOUND_STATUS_RESPONSE_FIELDS },
    errors: ["validation_failed", "not_found", "key_not_scoped", "capability_unavailable"],
  },
  {
    method: "GET",
    path: "/v1/domains/:id/dmarc_reports",
    summary: "List a domain's DMARC reports",
    auth: "Bearer key scoped to the domain",
    query: { schemaName: "listDmarcReportsSchema", schema: listDmarcReportsSchema, fields: fieldsFromSchema(listDmarcReportsSchema, "listDmarcReportsSchema") },
    response: {
      status: 200,
      description: "Aggregate reports mailbox providers sent to the domain's report address, newest first, kept as long as the organization keeps bodies. Empty until an admin sets up a report host and the domain publishes the address.",
      fields: dmarcReportPageFields,
    },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/reputation",
    summary: "Read the organization's standing",
    auth: "Bearer key with no domain scope",
    response: {
      status: 200,
      description: "The organization's reputation standing, computed when read. Check it before a bulk send.",
      fields: REPUTATION_RESPONSE_FIELDS,
    },
    errors: ["key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/stats",
    summary: "Read stats",
    auth: "Bearer key",
    query: { schemaName: "readStatsSchema", schema: readStatsSchema, fields: fieldsFromSchema(readStatsSchema, "readStatsSchema") },
    response: {
      status: 200,
      description: "Messages accepted in the window, against the window before it, in UTC buckets. A domain-scoped key counts its domains.",
      fields: STATS_RESPONSE_FIELDS,
    },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "POST",
    path: "/v1/emails",
    summary: "Send an email",
    auth: "Bearer key scoped to the from domain",
    request: {
      schemaName: "sendEmailSchema",
      schema: sendEmailSchema,
      fields: fieldsFromSchema(sendEmailSchema, "sendEmailSchema"),
      note: "html or text is required; at least one must be set. Accepts an Idempotency-Key header — a repeat within 24 hours returns the original response. layout is a boolean or an object: true uses the domain's layout as configured, an object of { name, logo, accent, footer } (all optional) overrides those fields for this send only.",
    },
    response: {
      status: 202,
      description: "The queued message. A Location header points at its url. Acceptance means persisted, not delivered.",
      fields: MESSAGE_BASE_FIELDS,
    },
    errors: [
      "validation_failed",
      "reserved_header",
      "domain_not_verified",
      "key_not_scoped",
      "organization_suspended",
      "provider_limit",
      "recipient_suppressed",
      "idempotency_conflict",
      "list_unsubscribe_required",
      "bulk_not_allowed",
      "feature_disabled",
      "provider_unavailable",
    ],
  },
  {
    method: "GET",
    path: "/v1/emails",
    summary: "List messages",
    auth: "Bearer key",
    query: { schemaName: "listMessagesSchema", schema: listMessagesSchema, fields: fieldsFromSchema(listMessagesSchema, "listMessagesSchema") },
    response: {
      status: 200,
      description: "A page of the key's messages, newest first.",
      fields: messagePageFields,
    },
    errors: ["validation_failed"],
  },
  {
    method: "GET",
    path: "/v1/emails/:id",
    summary: "Read a message",
    auth: "Bearer key scoped to the message's domain",
    response: {
      status: 200,
      description: "The message, with its full event history.",
      fields: MESSAGE_RESPONSE_FIELDS,
    },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "POST",
    path: "/v1/emails/:id/resend",
    summary: "Resend a message",
    auth: "Bearer key scoped to the message's domain",
    response: {
      status: 202,
      description: "The queued copy. A Location header points at its url.",
      fields: MESSAGE_BASE_FIELDS,
      note: "Takes no body. Sends a new message with the original's recipients, from, subject, body, attachments, tags, headers and layout, and resent_from set to the original. Every rule of POST /v1/emails applies, Idempotency-Key included. The copy keeps the original's test mode.",
    },
    errors: [
      "not_found",
      "key_not_scoped",
      "resend_not_allowed",
      "storage_unavailable",
      "validation_failed",
      "reserved_header",
      "domain_not_verified",
      "organization_suspended",
      "provider_limit",
      "attachment_too_large",
      "recipient_suppressed",
      "idempotency_conflict",
      "list_unsubscribe_required",
      "bulk_not_allowed",
      "provider_unavailable",
    ],
  },
  {
    method: "GET",
    path: "/v1/emails/:id/events",
    summary: "Watch a message",
    auth: "Bearer key scoped to the message's domain",
    response: {
      status: 200,
      description: "text/event-stream. Replays the message's existing transitions on connect, then holds the connection open until it reaches a terminal state, where the server closes it.",
      fields: STREAM_FRAME_FIELDS,
      note: "Honors a Last-Event-ID header on reconnect, replaying only what's new since then. Webhooks are how a system finds out; this is how a person watches — see docs/api/conventions.md.",
    },
    errors: ["not_found", "key_not_scoped", "stream_limit_exceeded", "provider_unavailable"],
  },
  {
    method: "GET",
    path: "/v1/events",
    summary: "Watch every message the key can see",
    auth: "Bearer key",
    query: { schemaName: "listEventsSchema", schema: listEventsSchema, fields: fieldsFromSchema(listEventsSchema, "listEventsSchema") },
    response: {
      status: 200,
      description: "text/event-stream, held open indefinitely — the client closes it, not the server.",
      fields: STREAM_FRAME_FIELDS,
      note: "A fresh connect with no Last-Event-ID starts from now rather than replaying history; Last-Event-ID on reconnect catches up on what was missed, capped at 500 events.",
    },
    errors: ["validation_failed", "stream_limit_exceeded", "provider_unavailable"],
  },
  {
    method: "GET",
    path: "/v1/inbound",
    summary: "List inbound mail",
    auth: "Bearer key",
    query: { schemaName: "listInboundSchema", schema: listInboundSchema, fields: fieldsFromSchema(listInboundSchema, "listInboundSchema") },
    response: { status: 200, description: "A page of mail the key's domains received, newest first, while it's retained.", fields: inboundPageFields },
    errors: ["validation_failed", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/inbound/:id",
    summary: "Read one inbound message",
    auth: "Bearer key scoped to the domain it was received on",
    response: { status: 200, description: "The message, while it's retained.", fields: INBOUND_READ_RESPONSE_FIELDS },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "POST",
    path: "/v1/addresses",
    summary: "Create an address",
    auth: "Bearer live key scoped to the domain",
    request: {
      schemaName: "createAddressSchema",
      schema: createAddressSchema,
      fields: fieldsFromSchema(createAddressSchema, "createAddressSchema"),
      note: "The domain needs inbound enabled. Mail to the address emits address.received to the creating key's endpoints. After expiry or revocation, mail is dropped silently and counted; nothing is refused or bounced.",
    },
    response: { status: 201, description: "The created address.", fields: ADDRESS_RESPONSE_FIELDS },
    errors: ["validation_failed", "not_found", "key_not_scoped", "inbound_disabled", "address_exists", "address_limit_reached"],
  },
  {
    method: "GET",
    path: "/v1/addresses",
    summary: "List addresses",
    auth: "Bearer live key",
    query: { schemaName: "listAddressesSchema", schema: listAddressesSchema, fields: fieldsFromSchema(listAddressesSchema, "listAddressesSchema") },
    response: { status: 200, description: "A page of the addresses on the key's domains, newest first.", fields: addressPageFields },
    errors: ["validation_failed", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/addresses/:id",
    summary: "Read an address",
    auth: "Bearer live key scoped to the address's domain",
    response: { status: 200, description: "The address, with its counts.", fields: ADDRESS_RESPONSE_FIELDS },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "PATCH",
    path: "/v1/addresses/:id",
    summary: "Extend or update an address",
    auth: "Bearer live key scoped to the address's domain",
    request: {
      schemaName: "updateAddressSchema",
      schema: updateAddressSchema,
      fields: fieldsFromSchema(updateAddressSchema, "updateAddressSchema"),
      note: "Moving an expired address's expiry forward makes it active again, within the organization's limit. A revoked address can't be edited.",
    },
    response: { status: 200, description: "The updated address.", fields: ADDRESS_RESPONSE_FIELDS },
    errors: ["validation_failed", "not_found", "key_not_scoped", "address_limit_reached"],
  },
  {
    method: "DELETE",
    path: "/v1/addresses/:id",
    summary: "Revoke an address",
    auth: "Bearer live key scoped to the address's domain",
    response: {
      status: 200,
      description: "The revoked address. Mail to it is dropped and counted from now on, and its local part stays taken.",
      fields: ADDRESS_RESPONSE_FIELDS,
    },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/addresses/:id/messages",
    summary: "List an address's mail",
    auth: "Bearer live key scoped to the address's domain",
    query: { schemaName: "listAddressMessagesSchema", schema: listAddressMessagesSchema, fields: fieldsFromSchema(listAddressMessagesSchema, "listAddressMessagesSchema") },
    response: {
      status: 200,
      description:
        "A page of the mail delivered to the address, newest first, in the shape GET /v1/inbound/:id returns. Empty when wait ran out. A waiting request holds one of the key's stream slots.",
      fields: inboundPageFields,
    },
    errors: ["validation_failed", "not_found", "key_not_scoped", "stream_limit_exceeded"],
  },
  {
    method: "POST",
    path: "/v1/addresses/:id/reply",
    summary: "Reply from an address",
    auth: "Bearer live key scoped to the address's domain",
    request: {
      schemaName: "replyFromAddressSchema",
      schema: replyFromAddressSchema,
      fields: fieldsFromSchema(replyFromAddressSchema, "replyFromAddressSchema"),
      note: "Sends from the address to the message's Reply-To, or its sender, with In-Reply-To and References set from it. Every rule of POST /v1/emails applies, Idempotency-Key included. The address has to be active.",
    },
    response: {
      status: 202,
      description: "The queued reply. A Location header points at its url.",
      fields: MESSAGE_BASE_FIELDS,
    },
    errors: [
      "validation_failed",
      "not_found",
      "key_not_scoped",
      "address_inactive",
      "reply_not_allowed",
      "domain_not_verified",
      "organization_suspended",
      "provider_limit",
      "recipient_suppressed",
      "idempotency_conflict",
      "list_unsubscribe_required",
      "bulk_not_allowed",
      "attachment_too_large",
      "provider_unavailable",
    ],
  },
  {
    method: "POST",
    path: "/v1/addresses/:id/forward_targets",
    summary: "Add a forward target",
    auth: "Bearer live key scoped to the address's domain",
    request: {
      schemaName: "addForwardTargetSchema",
      schema: addForwardTargetSchema,
      fields: fieldsFromSchema(addForwardTargetSchema, "addForwardTargetSchema"),
      note: "Mails a confirmation link to the mailbox from the system from address. Nothing forwards until the mailbox confirms. A forward comes from the address, with Reply-To set to the original sender. Spam, DMARC failures and viruses never forward.",
    },
    response: { status: 201, description: "The pending target.", fields: FORWARD_TARGET_RESPONSE_FIELDS },
    errors: [
      "validation_failed",
      "not_found",
      "key_not_scoped",
      "address_inactive",
      "forward_not_allowed",
      "forward_target_exists",
      "forward_target_limit_reached",
      "rate_limit_exceeded",
      "provider_unavailable",
    ],
  },
  {
    method: "GET",
    path: "/v1/addresses/:id/forward_targets",
    summary: "List forward targets",
    auth: "Bearer live key scoped to the address's domain",
    response: { status: 200, description: "The address's targets, with why any was disabled.", fields: forwardTargetPageFields },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/addresses/:id/forward_targets/:targetId",
    summary: "Read a forward target",
    auth: "Bearer live key scoped to the address's domain",
    response: { status: 200, description: "The target.", fields: FORWARD_TARGET_RESPONSE_FIELDS },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "DELETE",
    path: "/v1/addresses/:id/forward_targets/:targetId",
    summary: "Remove a forward target",
    auth: "Bearer live key scoped to the address's domain",
    response: { status: 200, description: "The removed target. Forwards still queued for it don't send.", fields: FORWARD_TARGET_RESPONSE_FIELDS },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "POST",
    path: "/v1/addresses/:id/forward_targets/:targetId/resend_confirmation",
    summary: "Resend a forward confirmation",
    auth: "Bearer live key scoped to the address's domain",
    response: { status: 200, description: "The target with a new link and expiry. The previous link stops working.", fields: FORWARD_TARGET_RESPONSE_FIELDS },
    errors: ["not_found", "key_not_scoped", "address_inactive", "forward_not_allowed", "forward_target_not_pending", "rate_limit_exceeded", "provider_unavailable"],
  },
  {
    method: "GET",
    path: "/v1/providers",
    summary: "List providers",
    auth: "Bearer key with no domain scope",
    query: { schemaName: "listProvidersSchema", schema: listProvidersSchema, fields: fieldsFromSchema(listProvidersSchema, "listProvidersSchema") },
    response: { status: 200, description: "A page of the organization's providers, newest first.", fields: providerPageFields },
    errors: ["validation_failed", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/providers/:id",
    summary: "Read a provider",
    auth: "Bearer key with no domain scope",
    response: { status: 200, description: "The provider.", fields: PROVIDER_RESPONSE_FIELDS },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "POST",
    path: "/v1/exports",
    summary: "Request an export",
    auth: "Bearer key",
    request: { schemaName: "createExportSchema", schema: createExportSchema, fields: fieldsFromSchema(createExportSchema, "createExportSchema") },
    response: {
      status: 202,
      description: "The queued export. Poll GET /v1/exports/:id until status is ready, failed or expired.",
      fields: EXPORT_RESPONSE_FIELDS,
      note: "Always queues, whatever the row count — there's no synchronous response shape here, unlike the dashboard's own export routes below their size ceiling.",
    },
    errors: ["validation_failed", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/exports",
    summary: "List exports",
    auth: "Bearer key",
    query: { schemaName: "listExportsSchema", schema: listExportsSchema, fields: fieldsFromSchema(listExportsSchema, "listExportsSchema") },
    response: {
      status: 200,
      description: "A page of the organization's exports, newest first.",
      fields: exportPageFields,
    },
    errors: ["validation_failed", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/exports/:id",
    summary: "Read an export",
    auth: "Bearer key",
    response: { status: 200, description: "The export's current status.", fields: EXPORT_RESPONSE_FIELDS },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "POST",
    path: "/v1/suppressions",
    summary: "Import suppressions",
    auth: "Bearer key with no domain scope",
    request: {
      schemaName: "importSuppressionsSchema",
      schema: importSuppressionsSchema,
      fields: fieldsFromSchema(importSuppressionsSchema, "importSuppressionsSchema"),
      note: `Takes up to ${SUPPRESSION_IMPORT_LIMIT} rows per call as JSON, or a text/csv body with an address (or email) column and optional reason, detail and source columns, with reason and source in the query string. A CSV reason cell that isn't hard_bounce, complaint or manual (or HardBounce, SpamComplaint, bounce and similar) falls back to the default reason and is kept as the detail. Addresses are normalized the same way a send is. An address already suppressed keeps its existing row. A bad row is reported, not fatal to the rest, and the valid rows commit together.`,
    },
    response: { status: 200, description: "Counts for the import and the rows that were skipped.", fields: SUPPRESSION_IMPORT_FIELDS },
    errors: ["validation_failed", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/suppressions",
    summary: "List suppressions",
    auth: "Bearer key with no domain scope",
    query: { schemaName: "listSuppressionsSchema", schema: listSuppressionsSchema, fields: fieldsFromSchema(listSuppressionsSchema, "listSuppressionsSchema") },
    response: {
      status: 200,
      description: "A page of the organization's suppressions, newest first.",
      fields: [
        { name: "data", type: `{ ${SUPPRESSION_RESPONSE_FIELDS.map((f) => f.name).join(", ")} }[]`, description: "Suppressions on this page." },
        { name: "next_cursor", type: "string | null", description: "Pass as cursor for the next page. Null on the last page." },
      ],
    },
    errors: ["validation_failed", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/suppressions/:address",
    summary: "Read a suppression",
    auth: "Bearer key with no domain scope",
    response: {
      status: 200,
      description: "One suppression.",
      fields: SUPPRESSION_RESPONSE_FIELDS,
      note: "The path segment is the suppression's id or the address, URL-encoded, matched on its normalized form. For the address's send history, list GET /v1/emails with to.",
    },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "DELETE",
    path: "/v1/suppressions/:address",
    summary: "Remove a suppression",
    auth: "Bearer key with no domain scope",
    response: {
      status: 200,
      description: "Confirms removal. Sends to the address go out again.",
      fields: REMOVE_SUPPRESSION_RESPONSE_FIELDS,
      note: "The path segment is the address, URL-encoded, matched on its normalized form. An address that isn't on the list is a 404.",
    },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/recipients/:address",
    summary: "Read a recipient",
    auth: "Bearer live key with no domain scope",
    response: {
      status: 200,
      description: "What the organization has on one address: its messages and their outcomes, its suppression and its unsubscribes.",
      fields: RECIPIENT_RESPONSE_FIELDS,
      note: "The path segment is the address, URL-encoded, matched on its normalized form. An address with no message, suppression or unsubscribe on file is a 404. One address per read: there's no list of every recipient.",
    },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "POST",
    path: "/v1/lists",
    summary: "Create a list",
    auth: "Bearer key",
    request: { schemaName: "createListSchema", schema: createListSchema, fields: fieldsFromSchema(createListSchema, "createListSchema") },
    response: { status: 201, description: "The created list.", fields: LIST_RESPONSE_FIELDS },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/lists",
    summary: "List lists",
    auth: "Bearer key",
    query: { schemaName: "listListsSchema", schema: listListsSchema, fields: fieldsFromSchema(listListsSchema, "listListsSchema") },
    response: { status: 200, description: "A page of the organization's lists, newest first.", fields: listPageFields },
    errors: ["validation_failed"],
  },
  {
    method: "GET",
    path: "/v1/lists/:id",
    summary: "Read a list",
    auth: "Bearer key scoped to the list's domain",
    response: { status: 200, description: "The list.", fields: LIST_READ_FIELDS },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "PATCH",
    path: "/v1/lists/:id",
    summary: "Update a list",
    auth: "Bearer key scoped to the list's domain",
    request: {
      schemaName: "updateListSchema",
      schema: updateListSchema,
      fields: fieldsFromSchema(updateListSchema, "updateListSchema"),
      note: "double_opt_in governs adds from here on. A membership stores the mode it was added under, so nothing already on the list changes status.",
    },
    response: { status: 200, description: "The updated list.", fields: LIST_RESPONSE_FIELDS },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "DELETE",
    path: "/v1/lists/:id",
    summary: "Delete a list",
    auth: "Bearer key scoped to the list's domain",
    response: { status: 200, description: "Confirms removal. Every membership on the list is removed with it.", fields: DELETE_LIST_RESPONSE_FIELDS },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "POST",
    path: "/v1/lists/:id/members",
    summary: "Add or import members",
    auth: "Bearer key scoped to the list's domain",
    request: {
      schemaName: "addMemberSchema",
      schema: addMemberSchema,
      fields: fieldsFromSchema(addMemberSchema, "addMemberSchema"),
      note: "A single { address, ... } JSON body adds one member and returns 201 with the membership. A { members: [...], confirmed } JSON body, or a text/csv body (a header row with an address column, an optional confirmed column and any other column becoming an attribute), imports up to 5000 at once — same header shape GET /v1/lists/:id/export writes, so a re-upload of an export round-trips. Both import forms return 200 with { imported: Membership[], added, already_present, invalid, errors: [{ line, address, message }] }, where imported holds every named membership, new or not; a bad row is reported, not fatal to the rest. Never resurrects an address that already unsubscribed.",
    },
    response: { status: 201, description: "The created membership. 200 with { imported, added, already_present, invalid, errors } for either import form — see the note.", fields: MEMBERSHIP_RESPONSE_FIELDS },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/lists/:id/members",
    summary: "List members",
    auth: "Bearer key scoped to the list's domain",
    query: { schemaName: "listMembersSchema", schema: listMembersSchema, fields: fieldsFromSchema(listMembersSchema, "listMembersSchema") },
    response: { status: 200, description: "A page of the list's members, newest first.", fields: membershipPageFields },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "PATCH",
    path: "/v1/lists/:id/members/:memberId",
    summary: "Update a member's attributes",
    auth: "Bearer key scoped to the list's domain",
    request: {
      schemaName: "updateMemberSchema",
      schema: updateMemberSchema,
      fields: fieldsFromSchema(updateMemberSchema, "updateMemberSchema"),
      note: "Replaces the attribute map outright rather than merging it, so a key left out is gone. Address, status and source aren't editable: a different address is a different member, and consent moves through the confirm and unsubscribe doors.",
    },
    response: { status: 200, description: "The updated membership.", fields: MEMBERSHIP_RESPONSE_FIELDS },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "DELETE",
    path: "/v1/lists/:id/members/:memberId",
    summary: "Remove a member",
    auth: "Bearer key scoped to the list's domain",
    response: {
      status: 200,
      description: "Confirms removal.",
      fields: REMOVE_MEMBER_RESPONSE_FIELDS,
      note: "Removes the membership outright — not the same as unsubscribing it.",
    },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/lists/:id/export",
    summary: "Export members as CSV",
    auth: "Bearer key scoped to the list's domain",
    response: {
      status: 200,
      description: "text/csv, one row per member.",
      fields: [
        { name: "address", type: "string", description: "Normalized recipient address." },
        { name: "status", type: "pending | subscribed | unsubscribed", description: "Whether this address currently receives a batch." },
        { name: "source", type: "api | import | manual", description: "How this membership was created." },
        { name: "confirmed_at", type: "string | null", description: "ISO 8601 timestamp, or empty." },
        { name: "confirmed_by", type: "link | import | not_required | null", description: "Which mode confirmed this membership." },
        { name: "unsubscribed_at", type: "string | null", description: "ISO 8601 timestamp, or empty." },
        { name: "created_at", type: "string", description: "ISO 8601 timestamp." },
        { name: "attributes", type: "string", description: "The attribute map, JSON-encoded in the cell." },
      ],
    },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "POST",
    path: "/v1/lists/:id/unsubscribe",
    summary: "Unsubscribe an address from a list",
    auth: "Bearer key scoped to the list's domain",
    request: { schemaName: "unsubscribeAddressSchema", schema: unsubscribeAddressSchema, fields: fieldsFromSchema(unsubscribeAddressSchema, "unsubscribeAddressSchema") },
    response: { status: 200, description: "Confirms the unsubscribe. Emits email.unsubscribed.", fields: UNSUBSCRIBE_RESPONSE_FIELDS },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "POST",
    path: "/v1/domains/:id/unsubscribe",
    summary: "Unsubscribe an address from every list on a domain",
    auth: "Bearer key scoped to the domain",
    request: { schemaName: "unsubscribeAddressSchema", schema: unsubscribeAddressSchema, fields: fieldsFromSchema(unsubscribeAddressSchema, "unsubscribeAddressSchema") },
    response: { status: 200, description: "Confirms the unsubscribe. Emits email.unsubscribed.", fields: UNSUBSCRIBE_RESPONSE_FIELDS },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "POST",
    path: "/v1/batches",
    summary: "Send a batch",
    auth: "Bearer key scoped to the from domain",
    request: {
      schemaName: "createBatchSchema",
      schema: createBatchSchema,
      fields: fieldsFromSchema(createBatchSchema, "createBatchSchema"),
      note: "Exactly one of list or recipients. attributes are substituted into {{name}} placeholders in subject, html and text. Every message carries a service-signed List-Unsubscribe and List-Unsubscribe-Post — this route takes no headers field.",
    },
    response: { status: 201, description: "The created batch, with per-status counts.", fields: BATCH_RESPONSE_FIELDS },
    errors: ["validation_failed", "domain_not_verified", "key_not_scoped", "organization_suspended", "not_found", "bulk_not_allowed", "provider_unavailable"],
  },
  {
    method: "GET",
    path: "/v1/batches/:id",
    summary: "Read a batch",
    auth: "Bearer key scoped to the batch's domain",
    response: { status: 200, description: "The batch, with its messages' current counts per status.", fields: BATCH_RESPONSE_FIELDS },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "POST",
    path: "/v1/confirm",
    summary: "Redeem a double opt-in confirmation",
    auth: "None — the token is the credential",
    request: { schemaName: "confirmSchema", schema: confirmSchema, fields: fieldsFromSchema(confirmSchema, "confirmSchema") },
    response: { status: 200, description: "Confirms the membership. Emits list.subscribed.", fields: CONFIRM_RESPONSE_FIELDS },
    errors: ["validation_failed", "invalid_token"],
  },
  {
    method: "POST",
    path: "/v1/unsubscribe",
    summary: "Redeem an unsubscribe token",
    auth: "None, CORS-open — the redemption target for a domain's branded unsubscribe_url page",
    request: { schemaName: "unsubscribeRedeemSchema", schema: unsubscribeRedeemSchema, fields: fieldsFromSchema(unsubscribeRedeemSchema, "unsubscribeRedeemSchema") },
    response: {
      status: 200,
      description: "Confirms the unsubscribe. Emits email.unsubscribed.",
      fields: UNSUBSCRIBE_REDEEM_RESPONSE_FIELDS,
      note: "The hosted GET/POST /u/:token page is the List-Unsubscribe and one-click target; this route is for a domain's own page to call from a visitor's browser.",
    },
    errors: ["validation_failed", "invalid_token"],
  },
  {
    method: "POST",
    path: "/v1/keys",
    summary: "Create a key",
    auth: "Bearer key with no domain scope",
    request: {
      schemaName: "createKeySchema",
      schema: createKeySchema,
      fields: fieldsFromSchema(createKeySchema, "createKeySchema"),
      note: "The secret is in this response and nowhere else. A test-mode key can only create test-mode keys, and a key limited to domains can't manage keys at all.",
    },
    response: { status: 201, description: "The created key, with its secret.", fields: MINTED_KEY_RESPONSE_FIELDS },
    errors: ["validation_failed", "key_not_scoped", "not_found"],
  },
  {
    method: "GET",
    path: "/v1/keys",
    summary: "List keys",
    auth: "Bearer key with no domain scope",
    query: { schemaName: "listKeysSchema", schema: listKeysSchema, fields: fieldsFromSchema(listKeysSchema, "listKeysSchema") },
    response: { status: 200, description: "A page of the organization's keys, newest first. Admin keys are never listed.", fields: keyPageFields },
    errors: ["validation_failed", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/keys/:id",
    summary: "Read a key",
    auth: "Bearer key with no domain scope",
    response: { status: 200, description: "The key. Never its secret.", fields: KEY_RESPONSE_FIELDS },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "PATCH",
    path: "/v1/keys/:id",
    summary: "Update a key",
    auth: "Bearer key with no domain scope",
    request: {
      schemaName: "updateKeySchema",
      schema: updateKeySchema,
      fields: fieldsFromSchema(updateKeySchema, "updateKeySchema"),
      note: "Name, rate limit and domain scope. Never the secret: a leaked key is revoked and re-minted, not patched. A revoked key can't be edited.",
    },
    response: { status: 200, description: "The updated key.", fields: KEY_RESPONSE_FIELDS },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "DELETE",
    path: "/v1/keys/:id",
    summary: "Revoke a key",
    auth: "Bearer key with no domain scope",
    response: {
      status: 200,
      description: "The revoked key. The row stays, so the messages it sent keep naming it; the secret stops authenticating immediately.",
      fields: KEY_RESPONSE_FIELDS,
    },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "POST",
    path: "/v1/webhook_endpoints",
    summary: "Create a webhook endpoint",
    auth: "Bearer key with no domain scope",
    request: {
      schemaName: "createWebhookEndpointSchema",
      schema: createWebhookEndpointSchema,
      fields: fieldsFromSchema(createWebhookEndpointSchema, "createWebhookEndpointSchema"),
      note: "An endpoint belongs to a key: only a send made with that key produces events for it.",
    },
    response: { status: 201, description: "The created endpoint, with its signing secret.", fields: WEBHOOK_ENDPOINT_SECRET_FIELDS },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/webhook_endpoints",
    summary: "List webhook endpoints",
    auth: "Bearer key with no domain scope",
    query: { schemaName: "listWebhookEndpointsSchema", schema: listWebhookEndpointsSchema, fields: fieldsFromSchema(listWebhookEndpointsSchema, "listWebhookEndpointsSchema") },
    response: {
      status: 200,
      description: "A page of the organization's key-scoped endpoints, newest first. A domain's inbound endpoint isn't one of them.",
      fields: webhookEndpointPageFields,
    },
    errors: ["validation_failed", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/webhook_endpoints/:id",
    summary: "Read a webhook endpoint",
    auth: "Bearer key with no domain scope",
    response: { status: 200, description: "The endpoint. Never its secret.", fields: WEBHOOK_ENDPOINT_RESPONSE_FIELDS },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "PATCH",
    path: "/v1/webhook_endpoints/:id",
    summary: "Update a webhook endpoint",
    auth: "Bearer key with no domain scope",
    request: {
      schemaName: "updateWebhookEndpointSchema",
      schema: updateWebhookEndpointSchema,
      fields: fieldsFromSchema(updateWebhookEndpointSchema, "updateWebhookEndpointSchema"),
      note: "disabled: true stops delivery and keeps the endpoint. The secret is unchanged — rotate it through its own route.",
    },
    response: { status: 200, description: "The updated endpoint.", fields: WEBHOOK_ENDPOINT_RESPONSE_FIELDS },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "DELETE",
    path: "/v1/webhook_endpoints/:id",
    summary: "Delete a webhook endpoint",
    auth: "Bearer key with no domain scope",
    response: {
      status: 200,
      description: "Confirms the delete.",
      fields: [
        { name: "id", type: "string", description: "The deleted endpoint's id." },
        { name: "deleted", type: "true", description: "Always true — the route errors instead of returning false." },
      ],
    },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "POST",
    path: "/v1/webhook_endpoints/:id/rotate_secret",
    summary: "Rotate a webhook signing secret",
    auth: "Bearer key with no domain scope",
    response: {
      status: 200,
      description: "The endpoint with its new secret, returned once. The old secret stops verifying immediately, so publish the new one before the next event.",
      fields: WEBHOOK_ENDPOINT_SECRET_FIELDS,
    },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/webhook_endpoints/:id/deliveries",
    summary: "List an endpoint's deliveries",
    auth: "Bearer key with no domain scope",
    query: { schemaName: "listWebhookDeliveriesSchema", schema: listWebhookDeliveriesSchema, fields: fieldsFromSchema(listWebhookDeliveriesSchema, "listWebhookDeliveriesSchema") },
    response: {
      status: 200,
      description: "A page of the endpoint's deliveries, newest first, without payloads unless include=payload asks.",
      fields: webhookDeliveryPageFields,
    },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/webhook_endpoints/:id/deliveries/:deliveryId",
    summary: "Read a webhook delivery",
    auth: "Bearer key with no domain scope",
    response: { status: 200, description: "One delivery, with its payload and attempts.", fields: WEBHOOK_DELIVERY_RESPONSE_FIELDS },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/activity",
    summary: "List activity",
    auth: "Bearer key with no domain scope",
    query: { schemaName: "listActivitySchema", schema: listActivitySchema, fields: fieldsFromSchema(listActivitySchema, "listActivitySchema") },
    response: { status: 200, description: "A page of the organization's activity log, newest first.", fields: activityPageFields },
    errors: ["validation_failed", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/activity/:id",
    summary: "Read an activity entry",
    auth: "Bearer key with no domain scope",
    response: { status: 200, description: "One entry in the organization's activity log.", fields: ACTIVITY_RESPONSE_FIELDS },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/organization",
    summary: "Read the organization",
    auth: "Bearer key with no domain scope",
    response: { status: 200, description: "The key's own organization.", fields: ORGANIZATION_RESPONSE_FIELDS },
    errors: ["not_found", "key_not_scoped"],
  },
  {
    method: "PATCH",
    path: "/v1/organization",
    summary: "Update the organization",
    auth: "Bearer key with no domain scope",
    request: {
      schemaName: "updateOrganizationSettingsSchema",
      schema: updateOrganizationSettingsSchema,
      fields: fieldsFromSchema(updateOrganizationSettingsSchema, "updateOrganizationSettingsSchema"),
      note: "Lowering body_retention_days shortens how long every body stays readable, existing ones included. The slug is read-only here.",
    },
    response: { status: 200, description: "The updated organization.", fields: ORGANIZATION_RESPONSE_FIELDS },
    errors: ["validation_failed", "not_found", "key_not_scoped"],
  },
  {
    method: "GET",
    path: "/v1/admin/providers",
    summary: "List every provider",
    auth: ADMIN,
    query: { schemaName: "listAdminProvidersSchema", schema: listAdminProvidersSchema, fields: fieldsFromSchema(listAdminProvidersSchema, "listAdminProvidersSchema") },
    response: { status: 200, description: "A page of providers, newest first. An organization's own row on a shared provider is an assignment, not a provider, and isn't listed.", fields: adminProviderPageFields },
    errors: [...ADMIN_ERRORS, "validation_failed"],
  },
  {
    method: "POST",
    path: "/v1/admin/providers",
    summary: "Create a provider",
    auth: ADMIN,
    request: {
      schemaName: "createAdminProviderSchema",
      schema: createAdminProviderSchema,
      fields: fieldsFromSchema(createAdminProviderSchema, "createAdminProviderSchema"),
      note: "Credentials are checked live first. A shareable adapter belongs to the service and runs its setup before responding.",
    },
    response: {
      status: 201,
      description: "The created provider, with credentials_verified and configured (whether setup finished).",
      fields: [...ADMIN_PROVIDER_WRITE_FIELDS, { name: "configured", type: "boolean", description: "Whether the provider's setup finished." }],
    },
    errors: [...ADMIN_ERRORS, "validation_failed", "not_found", "provider_exists", "credentials_rejected", "provider_unavailable"],
  },
  {
    method: "GET",
    path: "/v1/admin/providers/:id",
    summary: "Read a provider",
    auth: ADMIN,
    response: { status: 200, description: "The provider.", fields: ADMIN_PROVIDER_FIELDS },
    errors: [...ADMIN_ERRORS, "not_found"],
  },
  {
    method: "PATCH",
    path: "/v1/admin/providers/:id",
    summary: "Update a provider",
    auth: ADMIN,
    request: {
      schemaName: "patchAdminProviderSchema",
      schema: patchAdminProviderSchema,
      fields: fieldsFromSchema(patchAdminProviderSchema, "patchAdminProviderSchema"),
      note: "New credentials are checked live before they replace the old ones. On a shared provider they replace every organization's copy too.",
    },
    response: { status: 200, description: "The updated provider. credentials_verified is present only when credentials changed.", fields: ADMIN_PROVIDER_WRITE_FIELDS },
    errors: [...ADMIN_ERRORS, "validation_failed", "not_found", "provider_exists", "credentials_rejected"],
  },
  {
    method: "DELETE",
    path: "/v1/admin/providers/:id",
    summary: "Delete a provider",
    auth: ADMIN,
    response: {
      status: 200,
      description: "Confirms the delete.",
      fields: [
        { name: "id", type: "string", description: "The deleted provider's id." },
        { name: "deleted", type: "boolean", description: "Always true." },
      ],
    },
    errors: [...ADMIN_ERRORS, "not_found", "provider_in_use"],
  },
  {
    method: "POST",
    path: "/v1/admin/providers/:id/test",
    summary: "Check a provider",
    auth: ADMIN,
    response: {
      status: 200,
      description: "The live check's verdict, recorded as the provider's latest probe.",
      fields: [
        { name: "id", type: "string", description: "The provider's id." },
        { name: "ok", type: "boolean | null", description: "null means the adapter can't check itself." },
        { name: "detail", type: "string | null", description: "What's wrong, in a fixed category. Never provider text." },
        { name: "throttled", type: "boolean", description: "True when the provider throttled the check, which says nothing about the provider." },
        { name: "checked_at", type: "string", description: "ISO 8601 timestamp." },
      ],
    },
    errors: [...ADMIN_ERRORS, "not_found"],
  },
  {
    method: "POST",
    path: "/v1/admin/providers/:id/setup",
    summary: "Run a provider's setup again",
    auth: ADMIN,
    response: {
      status: 200,
      description: "The provider, with configured. Setup runs inline, about ten paced provider calls; a step that fails is retried by calling this again.",
      fields: [...ADMIN_PROVIDER_FIELDS, { name: "configured", type: "boolean", description: "Whether setup finished." }],
    },
    errors: [...ADMIN_ERRORS, "not_found"],
  },
  {
    method: "GET",
    path: "/v1/admin/providers/:id/convert",
    summary: "Read a conversion",
    auth: ADMIN,
    response: {
      status: 200,
      description: "What converting this provider does, and its latest run. Makes no provider call. Also answers after the move, once the provider is an organization's row on a shared one.",
      fields: CONVERSION_FIELDS,
    },
    errors: [...ADMIN_ERRORS, "not_found", "validation_failed"],
  },
  {
    method: "POST",
    path: "/v1/admin/providers/:id/convert",
    summary: "Move a legacy provider onto a shared one",
    auth: ADMIN,
    response: {
      status: 202,
      description: "The run started in the background, or one already running. Poll GET /v1/admin/providers/:id/convert until conversion.state is done or failed. A failed run resumes where it stopped when started again.",
      fields: [...CONVERSION_FIELDS, { name: "started", type: "boolean", description: "False when a run was already in progress." }],
    },
    errors: [...ADMIN_ERRORS, "not_found", "validation_failed"],
  },
  {
    method: "POST",
    path: "/v1/admin/domains",
    summary: "Adopt a domain the provider already holds",
    auth: ADMIN,
    request: {
      schemaName: "adoptDomainSchema",
      schema: adoptDomainSchema,
      fields: fieldsFromSchema(adoptDomainSchema, "adoptDomainSchema"),
      note: "Tags the provider's existing domain for the organization and attaches it, keeping its signing keys, so the domain never stops sending. POST /v1/domains answers domain_unavailable for the same name: adoption is admin-only. An identity tagged for another organization stays refused.",
    },
    response: {
      status: 201,
      description: "The adopted domain, verified straight away when the provider already sends for it.",
      fields: [...DOMAIN_RESPONSE_FIELDS, { name: "adopted", type: "boolean", description: "Always true." }],
    },
    errors: [
      ...ADMIN_ERRORS,
      "validation_failed",
      "not_found",
      "provider_unassigned",
      "capability_unavailable",
      "domain_exists",
      "domain_unavailable",
      "domain_not_at_provider",
      "provider_unavailable",
    ],
  },
  {
    method: "GET",
    path: "/v1/admin/providers/:id/organizations",
    summary: "List a provider's organizations",
    auth: ADMIN,
    query: { schemaName: "listProviderOrganizationsSchema", schema: listProviderOrganizationsSchema, fields: fieldsFromSchema(listProviderOrganizationsSchema, "listProviderOrganizationsSchema") },
    response: { status: 200, description: "A page of assignments, newest first.", fields: assignmentPageFields },
    errors: [...ADMIN_ERRORS, "not_found", "validation_failed"],
  },
  {
    method: "POST",
    path: "/v1/admin/providers/:id/organizations",
    summary: "Assign a provider to an organization",
    auth: ADMIN,
    request: {
      schemaName: "assignOrganizationSchema",
      schema: assignOrganizationSchema,
      fields: fieldsFromSchema(assignOrganizationSchema, "assignOrganizationSchema"),
      note: "Makes no provider call: the organization's space at the provider is created when it adds its first domain. Assigning again returns the same assignment.",
    },
    response: { status: 201, description: "The assignment.", fields: ASSIGNMENT_FIELDS },
    errors: [...ADMIN_ERRORS, "validation_failed", "not_found"],
  },
  {
    method: "DELETE",
    path: "/v1/admin/providers/:id/organizations/:organizationId",
    summary: "Unassign an organization",
    auth: ADMIN,
    response: {
      status: 200,
      description: "Confirms the unassignment. The organization's space at the provider is removed first.",
      fields: [
        { name: "provider_id", type: "string", description: "The provider." },
        { name: "organization_id", type: "string", description: "The organization." },
        { name: "unassigned", type: "boolean", description: "Always true." },
      ],
    },
    errors: [...ADMIN_ERRORS, "not_found", "validation_failed", "provider_in_use", "provider_unavailable"],
  },
  {
    method: "GET",
    path: "/v1/admin/organizations",
    summary: "List every organization",
    auth: ADMIN,
    query: { schemaName: "listAdminOrganizationsSchema", schema: listAdminOrganizationsSchema, fields: fieldsFromSchema(listAdminOrganizationsSchema, "listAdminOrganizationsSchema") },
    response: { status: 200, description: "A page of organizations, newest first.", fields: adminOrganizationPageFields },
    errors: [...ADMIN_ERRORS, "validation_failed"],
  },
  {
    method: "GET",
    path: "/v1/admin/organizations/:id",
    summary: "Read an organization",
    auth: ADMIN,
    response: { status: 200, description: "The organization.", fields: ADMIN_ORGANIZATION_FIELDS },
    errors: [...ADMIN_ERRORS, "not_found"],
  },
  {
    method: "PATCH",
    path: "/v1/admin/organizations/:id",
    summary: "Set an organization's default provider",
    auth: ADMIN,
    request: { schemaName: "patchAdminOrganizationSchema", schema: patchAdminOrganizationSchema, fields: fieldsFromSchema(patchAdminOrganizationSchema, "patchAdminOrganizationSchema") },
    response: { status: 200, description: "The updated organization.", fields: ADMIN_ORGANIZATION_FIELDS },
    errors: [...ADMIN_ERRORS, "validation_failed", "not_found"],
  },
  {
    method: "DELETE",
    path: "/v1/admin/organizations/:id",
    summary: "Delete an organization",
    auth: ADMIN,
    response: {
      status: 200,
      description: "Confirms the delete and counts what went with it.",
      fields: [
        { name: "id", type: "string", description: "The deleted organization's id." },
        { name: "deleted", type: "boolean", description: "Always true." },
        { name: "domains", type: "integer", description: "Domains deleted, at the provider as well as here." },
        { name: "messages", type: "integer", description: "Messages and their events deleted with it." },
      ],
      note: "Takes the organization's domains, keys, people, lists and send history with it. Shared providers and admin keys belong to the service and are untouched. Refused while it has mail waiting to send or holds the domain the service sends its own mail from. A provider that can't release a domain stops the delete part way; call it again to resume.",
    },
    errors: [...ADMIN_ERRORS, "not_found", "organization_in_use", "provider_unavailable"],
  },
  {
    method: "POST",
    path: "/v1/admin/organizations/:id/suspend",
    summary: "Suspend an organization",
    auth: ADMIN,
    request: {
      schemaName: "suspendOrganizationSchema",
      schema: suspendOrganizationSchema,
      fields: fieldsFromSchema(suspendOrganizationSchema, "suspendOrganizationSchema"),
      note: "A manual suspension: new sends are refused and queued mail fails. An existing suspension is kept as it is.",
    },
    response: { status: 200, description: "The organization, with changed.", fields: ADMIN_ORGANIZATION_CHANGE_FIELDS },
    errors: [...ADMIN_ERRORS, "validation_failed", "not_found"],
  },
  {
    method: "POST",
    path: "/v1/admin/organizations/:id/release",
    summary: "Release an organization's suspension",
    auth: ADMIN,
    response: { status: 200, description: "The organization, with changed. Releases a suspension of any source.", fields: ADMIN_ORGANIZATION_CHANGE_FIELDS },
    errors: [...ADMIN_ERRORS, "not_found"],
  },
  {
    method: "POST",
    path: "/v1/admin/organizations",
    summary: "Create an organization",
    auth: ADMIN,
    request: {
      schemaName: "createAdminOrganizationSchema",
      schema: createAdminOrganizationSchema,
      fields: fieldsFromSchema(createAdminOrganizationSchema, "createAdminOrganizationSchema"),
      note: "The key's creator becomes the owner, and the organization is assigned the default provider when one is set.",
    },
    response: { status: 201, description: "The created organization.", fields: ADMIN_ORGANIZATION_FIELDS },
    errors: [...ADMIN_ERRORS, "validation_failed"],
  },
  {
    method: "GET",
    path: "/v1/admin/organizations/:id/members",
    summary: "List an organization's members",
    auth: ADMIN,
    query: { schemaName: "listMembershipsSchema", schema: listMembershipsSchema, fields: fieldsFromSchema(listMembershipsSchema, "listMembershipsSchema") },
    response: { status: 200, description: "A page of members, oldest first.", fields: memberPageFields },
    errors: [...ADMIN_ERRORS, "validation_failed", "not_found"],
  },
  {
    method: "PATCH",
    path: "/v1/admin/organizations/:id/members/:userId",
    summary: "Change a member's role",
    auth: ADMIN,
    request: { schemaName: "patchMembershipSchema", schema: patchMembershipSchema, fields: fieldsFromSchema(patchMembershipSchema, "patchMembershipSchema") },
    response: { status: 200, description: "The member, with the new role.", fields: MEMBER_RESPONSE_FIELDS },
    errors: [...ADMIN_ERRORS, "validation_failed", "not_found"],
  },
  {
    method: "DELETE",
    path: "/v1/admin/organizations/:id/members/:userId",
    summary: "Remove a member from an organization",
    auth: ADMIN,
    response: {
      status: 200,
      description: "Confirms the removal.",
      fields: REMOVED_MEMBER_FIELDS,
      note: "Removes the membership only. The account stays, and the organization keys it created keep sending — rotate them if the person isn't trusted.",
    },
    errors: [...ADMIN_ERRORS, "validation_failed", "not_found"],
  },
  {
    method: "POST",
    path: "/v1/admin/organizations/:id/invitations",
    summary: "Invite someone to an organization",
    auth: ADMIN,
    request: {
      schemaName: "createInvitationSchema",
      schema: createInvitationSchema,
      fields: fieldsFromSchema(createInvitationSchema, "createInvitationSchema"),
      note: "Mails a one-time link that expires in 7 days. An address already in the organization, or already holding a live invitation to it, is refused — resend or revoke that one instead. An address that already has an account joins it rather than getting a second account. 503 provider_unavailable when the system from address isn't set up; nothing is created.",
    },
    response: { status: 201, description: "The created invitation. The token is mailed and never returned.", fields: INVITATION_RESPONSE_FIELDS },
    errors: [...ADMIN_ERRORS, "validation_failed", "not_found", "provider_unavailable"],
  },
  {
    method: "GET",
    path: "/v1/admin/organizations/:id/invitations",
    summary: "List an organization's invitations",
    auth: ADMIN,
    query: { schemaName: "listInvitationsSchema", schema: listInvitationsSchema, fields: fieldsFromSchema(listInvitationsSchema, "listInvitationsSchema") },
    response: { status: 200, description: "A page of invitations, newest first.", fields: invitationPageFields },
    errors: [...ADMIN_ERRORS, "validation_failed", "not_found"],
  },
  {
    method: "DELETE",
    path: "/v1/admin/organizations/:id/invitations/:invitationId",
    summary: "Revoke an invitation",
    auth: ADMIN,
    response: {
      status: 200,
      description: "The revoked invitation. Its link stops working immediately.",
      fields: INVITATION_RESPONSE_FIELDS,
      note: "Only a pending invitation can be revoked. An accepted one is a membership — remove that instead.",
    },
    errors: [...ADMIN_ERRORS, "validation_failed", "not_found"],
  },
  {
    method: "POST",
    path: "/v1/admin/organizations/:id/invitations/:invitationId/resend",
    summary: "Resend an invitation",
    auth: ADMIN,
    response: {
      status: 200,
      description: "The invitation, with a fresh expiry. A new token is mailed and the old link stops working.",
      fields: INVITATION_RESPONSE_FIELDS,
    },
    errors: [...ADMIN_ERRORS, "validation_failed", "not_found", "provider_unavailable"],
  },
  {
    method: "GET",
    path: "/v1/admin/users",
    summary: "List accounts",
    auth: ADMIN,
    query: { schemaName: "listAdminUsersSchema", schema: listAdminUsersSchema, fields: fieldsFromSchema(listAdminUsersSchema, "listAdminUsersSchema") },
    response: { status: 200, description: "A page of accounts, newest first.", fields: accountPageFields },
    errors: [...ADMIN_ERRORS, "validation_failed"],
  },
  {
    method: "GET",
    path: "/v1/admin/users/:id",
    summary: "Read an account",
    auth: ADMIN,
    response: { status: 200, description: "The account, with its memberships.", fields: ACCOUNT_RESPONSE_FIELDS },
    errors: [...ADMIN_ERRORS, "not_found"],
  },
  {
    method: "PATCH",
    path: "/v1/admin/users/:id",
    summary: "Grant or revoke service-wide admin",
    auth: ADMIN,
    request: {
      schemaName: "patchAdminUserSchema",
      schema: patchAdminUserSchema,
      fields: fieldsFromSchema(patchAdminUserSchema, "patchAdminUserSchema"),
      note: "Revoking revokes the admin keys this account created, including the one making the call. The last admin can't be demoted.",
    },
    response: { status: 200, description: "The account.", fields: ACCOUNT_RESPONSE_FIELDS },
    errors: [...ADMIN_ERRORS, "validation_failed", "not_found"],
  },
  {
    method: "DELETE",
    path: "/v1/admin/users/:id",
    summary: "Delete an account",
    auth: ADMIN,
    response: {
      status: 200,
      description: "Confirms the delete.",
      fields: DELETED_ACCOUNT_FIELDS,
      note: "Takes the account's memberships and sessions with it and revokes the admin keys it created. Organization keys it minted keep sending. The last admin can't be deleted.",
    },
    errors: [...ADMIN_ERRORS, "validation_failed", "not_found"],
  },
];

/** A read with a response shape and no query of its own documents `fields` and `include` from the shape, and can answer `validation_failed`. */
function withShapeQuery(route: RouteSpec): RouteSpec {
  const shape = route.method === "GET" ? shapeFor(route.method, route.path) : undefined;
  if (!shape) return route;
  const errors: ErrorCode[] = route.errors.includes("validation_failed") ? route.errors : ["validation_failed", ...route.errors];
  if (route.query) return { ...route, errors };
  const schemaName = `${shape.resource} fields`;
  const schema = shapeQuerySchema(shape);
  return { ...route, query: { schemaName, schema, fields: fieldsFromSchema(schema, schemaName) }, errors };
}

/** A route an optional feature owns answers `feature_disabled` while it's off. */
function withFeature(route: RouteSpec): RouteSpec {
  if (!featureForPath(route.path) || route.errors.includes("feature_disabled")) return route;
  return { ...route, errors: [...route.errors, "feature_disabled"] };
}

export const ROUTES: RouteSpec[] = DECLARED_ROUTES.map(withShapeQuery).map(withFeature);
