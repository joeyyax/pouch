/**
 * Pouch SDK. One file, zero runtime dependencies, `fetch` only.
 *
 * Covers every key-authenticated route in `lib/api-docs/spec.ts` apart from the streams and the
 * token routes. `tests/unit/sdk-coverage.test.ts` fails when a route has neither a method here
 * nor an entry in its exceptions list. See sdk/README.md for a runnable example.
 */

// ---------------------------------------------------------------------------
// Request and response shapes
//
// Hand-written rather than imported from `lib/schemas/*`: those are zod schemas, and importing
// them would pull zod into a package meant to have zero runtime dependencies. Types below are
// kept in lockstep with `lib/schemas/*` and the `serialize.ts` under each `lib/<resource>/`
// by hand.
// ---------------------------------------------------------------------------

/** One attachment on a send. `content` is base64-encoded. */
export interface PouchAttachment {
  filename: string;
  content: string;
  content_type: string;
}

/** Per-send overrides on the domain's layout. An omitted field falls back to the domain's value. */
export interface LayoutOverride {
  name?: string;
  /** An https URL. */
  logo?: string;
  /** A hex color, such as `#1d46f5`. */
  accent?: string;
  footer?: string;
}

/** Body of `POST /v1/emails`. At least one of `html` or `text` is required. */
export interface SendEmailRequest {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string | string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  tags?: string[];
  attachments?: PouchAttachment[];
  /** Wrap `html` in the domain's layout. Default `false`. */
  layout?: boolean | LayoutOverride;
  /** Withhold the body from every read. It can't be resent. Default `false`. */
  sensitive?: boolean;
}

export type MessageStatus = "queued" | "sent" | "delivered" | "deferred" | "bounced" | "complained" | "failed";

export interface MessageEvent {
  id: string;
  status: MessageStatus;
  reason: string | null;
  occurred_at: string;
}

/** A hint from the recipient's send history. Never changes whether the message was accepted. */
export interface SendWarning {
  code: "previously_bounced" | "previously_complained" | "frequent_deferrals" | (string & {});
  address: string;
  message: string;
  detail: Record<string, unknown>;
}

/** Sending is held: the message's domain is stalled, or its organization is suspended. */
export interface MessageStall {
  kind: "domain" | "organization";
  reason: string;
  message: string;
  stalled_at: string;
}

/** A message, the shape returned by both `POST /v1/emails` and `GET /v1/emails/:id`. */
export interface Message {
  id: string;
  url: string;
  status: MessageStatus;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[];
  subject: string;
  tags: string[];
  /** Custom headers as accepted. */
  headers: Record<string, string>;
  /** As the send asked for it: false, true, or the fields it overrode. */
  layout: boolean | LayoutOverride;
  /** The key that sent it. Null for mail sent without a key. */
  key_id: string | null;
  /** The batch it was sent in. Null for a single send. */
  batch_id: string | null;
  test_mode: boolean;
  /** The body is withheld from every read. */
  sensitive: boolean;
  /** The recipient's send history as it stood when this message was accepted. */
  warnings: SendWarning[];
  provider_message_id: string | null;
  reason: string | null;
  attempts: number;
  /** When the service next tries to send it. Null unless queued. */
  next_attempt_at: string | null;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  /** When the service stopped waiting on a provider that never reported back. Status stays `sent`. */
  abandoned_at: string | null;
  /** Bytes as accepted. Each is null on a message accepted before sizes were recorded. */
  size: { body_bytes: number | null; attachment_bytes: number | null };
  /** The message this one was resent from. Null for an original send. */
  resent_from: string | null;
  /** Copies resent from this message, oldest first. On `GET /v1/emails/:id`, or with `include: ["resends"]`. */
  resends?: { id: string; status: MessageStatus; created_at: string }[];
  /** Only present on `GET /v1/emails/:id`, or with `include: ["events"]`. */
  events?: MessageEvent[];
  /** With `include: ["occurrences"]`. */
  occurrences?: MessageOccurrence[];
  /** Only present on `GET /v1/emails/:id`. Null unless the message is queued and held. */
  stall?: MessageStall | null;
  /** With `include: ["body"]`. Null when it can't be read, and `body_unavailable` says why. */
  body?: MessageBody | null;
  /** With `include: ["rendered"]`. Null when the body can't be read. */
  rendered?: MessageRendered | null;
  body_unavailable?: MessageBodyUnavailable | null;
}

/** Something that happened to a message without changing its status. */
export type MessageOccurrence = { id: string; reason: string | null; occurred_at: string } & (
  | { kind: "retry"; detail: { attempt: number | null; next_attempt_at: string | null } }
  | { kind: "backoff"; detail: { until: string | null; count: number } }
  | { kind: "suppressed"; detail: { address: string | null; suppression_reason: string | null } }
  | { kind: "body_shredded"; detail: { retention_days: number | null } }
  | { kind: "webhook_delivered"; detail: { event_type: string | null; host: string | null; status_code: number | null } }
  | { kind: "abandoned"; detail: Record<string, never> }
);

export interface MessageRendered {
  /** The html part as the recipient got it, framed in the domain's layout when the send asked for one. */
  html: string | null;
  framed: boolean;
  /** True when the layout changed after the message was accepted. Null when that can't be told. */
  frame_changed: boolean | null;
}

export interface MessageBody {
  /** As accepted, before the domain's layout wraps it. */
  html: string | null;
  text: string | null;
  attachments: { filename: string; content_type: string; size: number; download_url: string }[];
}

export interface MessageBodyUnavailable {
  reason: "withheld" | "shredded" | "expired" | "unavailable";
  message: string;
  ended_at: string | null;
}

/**
 * `include` adds expansions; `fields` returns only the named top-level keys, plus `id`. A key
 * left out is absent from the response, whatever the type says. See docs/api/conventions.md.
 */
export interface ResponseShapeParams<Include extends string> {
  include?: Include[];
  fields?: string[];
}

export interface ListMessagesParams extends ResponseShapeParams<"events" | "occurrences" | "body" | "rendered"> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
  /** One status, or any of several. */
  status?: MessageStatus | MessageStatus[];
  /** A domain id. */
  domain?: string;
  /** A key id. */
  key?: string;
  /** A batch id. */
  batch?: string;
  /** True for queued messages a stall or suspension is holding, false for the rest. */
  held?: boolean;
  /** True for messages whose body is withheld, false for the rest. */
  sensitive?: boolean;
  tag?: string;
  /** A recipient in to, cc or bcc. */
  to?: string;
  /** A bounce or complaint reason, matched exactly. */
  reason?: string;
  /** ISO 8601 timestamp. */
  since?: string;
  /** ISO 8601 timestamp. */
  until?: string;
}

export interface MessagePage {
  data: Message[];
  next_cursor: string | null;
}

/** Body of `POST /v1/domains`. */
export interface CreateDomainRequest {
  name: string;
  /** Defaults to the organization's assigned provider. */
  provider_id?: string;
}

export type DomainStatus = "pending" | "verified" | "failed";

export type DnsRecordType = "TXT" | "CNAME" | "MX";

export interface DnsRecord {
  type: DnsRecordType;
  name: string;
  value: string;
  /** Set on MX records. */
  priority?: number;
  /** Set when the name may already hold an SPF record. Add this record's mechanisms to that one. */
  merge?: "spf";
  /** Whether the domain fails to verify without this record. */
  required: boolean;
}

/** A step the provider can't finish through its API, such as adding a webhook. */
export interface SetupStep {
  step: "domain" | "dns_records" | "verification" | "webhooks" | "credentials" | "removal";
  message: string;
}

export type DmarcPolicy = "none" | "quarantine" | "reject";
export type DmarcMode = "relaxed" | "strict";

export interface DmarcIdentityAlignment {
  /** The domains the setup authenticates mail as. */
  domains: string[];
  mode: DmarcMode;
  aligned: boolean;
}

export interface DmarcFinding {
  kind:
    | "missing"
    | "multiple_records"
    | "unparseable"
    | "unanswered"
    | "monitoring_only"
    | "dkim_not_aligned"
    | "spf_not_aligned"
    | "alignment_fails"
    | "no_report_address";
  /** `problem` needs a change. `note` doesn't. */
  severity: "problem" | "note";
  message: string;
}

/** A domain's DMARC record, read live. */
export interface Dmarc {
  /** Receivers ignore `multiple` and `invalid` records. `unresolved` is a lookup that didn't answer. */
  status: "found" | "missing" | "multiple" | "invalid" | "unresolved";
  /** Where the record was read: the domain's own `_dmarc` name or its organizational domain's. */
  record_name: string | null;
  source: "domain" | "organizational" | null;
  record: string | null;
  policy: DmarcPolicy | null;
  subdomain_policy: DmarcPolicy | null;
  percent: number | null;
  rua: string[];
  ruf: string[];
  adkim: DmarcMode | null;
  aspf: DmarcMode | null;
  /** Passes when either DKIM or SPF aligns. Null until the domain has records to measure. */
  alignment: { dkim: DmarcIdentityAlignment; spf: DmarcIdentityAlignment; passes: boolean } | null;
  findings: DmarcFinding[];
  /** The record to publish at `_dmarc.<domain>`, or null when nothing needs to change. */
  recommended: string | null;
}

/** One source address in a DMARC report. */
export interface DmarcReportRecord {
  source_ip: string;
  count: number;
  /** Who sent it, as the domain's own records tell. */
  origin: "provider" | "other" | "forwarded" | "unauthenticated";
  disposition: string;
  /** The receiver's aligned verdicts. */
  dkim: "pass" | "fail";
  spf: "pass" | "fail";
  header_from: string;
  envelope_from: string | null;
  dkim_results: { domain: string; selector: string | null; result: string }[];
  spf_results: { domain: string; scope: string | null; result: string }[];
}

/** `GET /v1/domains/:id/dmarc_reports`. */
export interface DmarcReport {
  id: string;
  domain_id: string;
  reporter: string;
  reporter_email: string | null;
  report_id: string;
  begins_at: string;
  ends_at: string;
  policy: { domain: string; p: string | null; sp: string | null; pct: number | null; adkim: string | null; aspf: string | null };
  message_count: number;
  received_at: string;
  /** With `include: ["records"]`. */
  records?: DmarcReportRecord[];
}

export interface DmarcReportPage {
  data: DmarcReport[];
  next_cursor: string | null;
}

export interface ListDmarcReportsParams extends ResponseShapeParams<"records"> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
}

export interface Domain {
  id: string;
  name: string;
  status: DomainStatus;
  dns_records: DnsRecord[];
  missing_records: DnsRecord[];
  setup: SetupStep[];
  errors: string[];
  verified_at: string | null;
  last_checked_at: string | null;
  created_at: string;
  /** The provider this domain sends through now. */
  provider_id: string;
  pending: { provider_id: string; dns_records: DnsRecord[]; missing_records: DnsRecord[]; started_at: string } | null;
  stall: { reason: string; message: string; stalled_at: string } | null;
  bulk_allowed: boolean;
  /** The frame a send with `layout: true` is wrapped in. */
  layout: DomainLayout | null;
  standing: Standing;
  /** One sentence on why the domain isn't healthy. Null when it is. */
  standing_reason: string | null;
  /** With `include: ["reputation"]` on `domains.get`. Null until the domain has verified. */
  reputation?: DomainReputation | null;
  /** With `include: ["dmarc"]` on `domains.get`, and on every `domains.verify`. */
  dmarc?: Dmarc;
}

export interface DomainLayout {
  /** The logo's alt text, and what shows in its place without one. */
  name: string;
  /** An https URL. */
  logo: string | null;
  /** Hex, such as `#1d46f5`. */
  accent: string;
  footer: string;
}

export interface MetricReading {
  count: number;
  denominator: number;
  /** Null below the volume a rate needs. */
  rate: number | null;
  previous_rate: number | null;
  delta: number | null;
  watch_line: number;
  at_risk_line: number;
  stall_line: number;
  provider_review_line: number;
  provider_pause_line: number;
}

export interface DomainReputation {
  findings: { kind: string; standing: Exclude<Standing, "healthy">; title: string; body: string; action: string }[];
  /** 7 days, then 30. */
  windows: { days: number; bounce: MetricReading; complaint: MetricReading }[];
  reasons: { status: "bounced" | "complained"; reason: string; kind: string | null; count: number; last_at: string }[];
  signals: {
    window_hours: number;
    baseline_days: number;
    recent_total: number;
    baseline_total: number;
    recent_recipients: number;
    first_time_recipients: number;
    suppressed_rejections: number;
  } | null;
  blocklists: {
    state: "on" | "off" | "paused";
    lists: {
      list: "dbl" | "zrd";
      listed: boolean;
      code: string | null;
      reason: string | null;
      listed_since: string | null;
      expires_at: string | null;
      checked_at: string | null;
      last_error_at: string | null;
    }[];
    links: { domain: string; list: "dbl" | "zrd"; code: string; reason: string; messages: number; last_sent_at: string }[];
  };
  provider_findings: { type: string; impact: string | null; description: string | null; opened_at: string }[];
  tenant_volume: { days: number; sends: number; bounces: number; complaints: number } | null;
}

export type Standing = "healthy" | "watch" | "at_risk" | "paused";

/** `GET /v1/reputation`. Needs a key with no domain scope. */
export interface Reputation {
  object: "reputation";
  subject: { type: "organization"; id: string; name: string };
  standing: Standing;
  reason: string | null;
  findings: { kind: string; standing: Exclude<Standing, "healthy">; title: string; body: string; action: string }[];
  /** Domains that aren't healthy, worst first. */
  domains: { id: string; name: string; standing: Standing }[];
}

export interface StatusCounts {
  total: number;
  queued: number;
  sent: number;
  deferred: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  /** The part of `sent` the provider never reported on. */
  abandoned: number;
}

export interface LatencyQuantiles {
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  count: number;
}

export type StatsExpansion = "previous_buckets" | "latency" | "domains" | "keys" | "reasons" | "queue" | "inbound" | "domain_days";

export interface StatsParams extends ResponseShapeParams<StatsExpansion> {
  /** A window ending now. Default `30d`. Leave out with `since`. */
  window?: "24h" | "7d" | "30d" | "90d";
  /** ISO 8601, in place of `window`. */
  since?: string;
  /** ISO 8601, exclusive. Default now. */
  until?: string;
  /** UTC hours or days. Default hour for a day or less. */
  bucket?: "hour" | "day";
  /** Default `live`; a test key reads `test` only. */
  mode?: "live" | "test" | "all";
  /** A domain id. */
  domain?: string;
  /** A key id. */
  key?: string;
  status?: MessageStatus | MessageStatus[];
}

/** `GET /v1/stats`. Expansions are present only when asked for. */
export interface Stats {
  window: { since: string; until: string; previous_since: string; previous_until: string; bucket: "hour" | "day" };
  mode: "live" | "test" | "all";
  counts: StatusCounts;
  previous_counts: StatusCounts;
  attempts: { per_send: number | null; previous_per_send: number | null };
  buckets: ({ start: string } & StatusCounts)[];
  previous_buckets?: ({ start: string } & StatusCounts)[];
  latency?: { queue: LatencyQuantiles; provider: LatencyQuantiles; end_to_end: LatencyQuantiles };
  domains?: {
    domain_id: string;
    name: string;
    counts: StatusCounts;
    previous_total: number;
    queue_p95_ms: number | null;
    last_sent_at: string | null;
    buckets: number[];
  }[];
  keys?: { key_id: string | null; total: number; buckets: number[] }[];
  reasons?: { reason: string; count: number }[];
  queue?: {
    queued: number;
    due: number;
    backing_off: number;
    held: number;
    in_progress: number;
    silent: number;
    oldest_queued_at: string | null;
    oldest_due_at: string | null;
    oldest_held_at: string | null;
    held_by_domain: { domain_id: string; count: number; oldest_queued_at: string }[];
    organization_held: boolean;
    organization_fails: boolean;
  };
  inbound?: { total: number; buckets: number[] };
  domain_days?: {
    domain_id: string;
    day: string;
    computed_at: string;
    delivered_count: number;
    delivery_ms: Record<"min" | "p10" | "p25" | "p50" | "p75" | "p90" | "p99" | "max", number | null>;
    hourly_volume: number[];
  }[];
}

/** Body of `PATCH /v1/domains/:id`. At least one field is required. */
export interface UpdateDomainRequest {
  /** Provider to move this domain to. Records a pending binding; `null` cancels one in progress. */
  provider_id?: string | null;
  /** Whether this domain may send bulk batches. Off by default. */
  bulk_allowed?: boolean;
  /** Fields left out keep their stored value; without a layout, `name`, `accent` and `footer` are required. `null` removes it. */
  layout?: Partial<DomainLayout> | null;
}

export interface ListDomainsParams extends ResponseShapeParams<"standing"> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
  status?: DomainStatus;
}

export interface DomainPage {
  data: Domain[];
  next_cursor: string | null;
}

export interface DeleteDomainResult {
  id: string;
  deleted: true;
}

export type SuppressionReason = "hard_bounce" | "complaint" | "manual";

export interface Suppression {
  id: string;
  /** Domain part lowercased, local part kept. */
  address: string;
  reason: SuppressionReason;
  detail: string | null;
  /** The provider's bounce classification, such as `Permanent/NoEmail`. */
  bounce_type: string | null;
  /** Where an imported suppression came from. Null for a bounce, complaint or single add. */
  source: string | null;
  source_message_id: string | null;
  created_at: string;
}

/** Body of `POST /v1/suppressions`. Needs a key with no domain scope. */
export interface ImportSuppressionsRequest {
  /** At most 5000 per call. */
  suppressions: { address: string; reason?: SuppressionReason; detail?: string }[];
  /** For rows that don't set their own. Default `manual`. */
  reason?: SuppressionReason;
  /** Where the list came from, such as `postmark`. Default `api`. */
  source?: string;
}

/** An address already suppressed keeps its row and counts as `already_present`. */
export interface ImportSuppressionsResult {
  added: number;
  already_present: number;
  invalid: number;
  errors: { line: number | null; address: string; message: string }[];
}

export interface ListSuppressionsParams extends ResponseShapeParams<never> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
  reason?: SuppressionReason;
  address?: string;
  /** Domain id of the message that caused it. */
  domain?: string;
  /** ISO 8601 timestamp. */
  since?: string;
  /** ISO 8601 timestamp. */
  until?: string;
}

/** Result of `DELETE /v1/suppressions/:address`. An address that isn't on the list is a 404. */
export interface RemoveSuppressionResult {
  address: string;
  removed: true;
}

export interface SuppressionPage {
  data: Suppression[];
  next_cursor: string | null;
}

/** A message as a recipient's history lists it. */
export interface RecipientMessage {
  id: string;
  subject: string;
  domain_id: string;
  status: MessageStatus;
  test_mode: boolean;
  created_at: string;
}

/** `GET /v1/recipients/:address`. Needs a live key with no domain scope. */
export interface Recipient {
  /** Domain part lowercased, local part kept. */
  address: string;
  first_seen_at: string | null;
  last_sent_at: string | null;
  last_status: MessageStatus | null;
  domain_ids: string[];
  /** Messages addressed to it, by status. The rest are still in flight. */
  messages: { total: number; delivered: number; bounced: number; complained: number; failed: number };
  bounce_count: number;
  complaint_count: number;
  last_delivered_at: string | null;
  last_bounced_at: string | null;
  last_complained_at: string | null;
  suppression: (Suppression & { added_by: string | null; source_message: RecipientMessage | null }) | null;
  unsubscribes: {
    lists: { list_id: string; unsubscribed_at: string | null }[];
    domains: { domain_id: string; unsubscribed_at: string }[];
  };
  /** With `include: ["history"]`: the latest 50 messages, newest first. */
  history?: RecipientMessage[];
  /** With `include: ["history"]`: the latest 50 that bounced or complained. */
  incidents?: RecipientMessage[];
}

/** `GET /v1/domains/:id/inbound`. */
export interface InboundSettings {
  domain_id: string;
  enabled: boolean;
  /** 7 by default, up to the install's ceiling: 30 unless an admin changed it. */
  retention_days: number;
  /** The label mail is addressed to. `inbound` by default. */
  subdomain: string;
  /** `<subdomain>.<domain>`: mail to any address on it arrives. */
  host: string;
  webhook_url: string | null;
  /** Where this domain's provider should be told to POST inbound mail. Null when the provider is routed through its API. */
  receiver_url: string | null;
  dns_records: DnsRecord[];
  /** Returned only the moment a webhook URL is registered or rotated. */
  webhook_secret?: string;
}

/** Body of `PATCH /v1/domains/:id/inbound`. */
export interface UpdateInboundRequest {
  enabled: boolean;
  /** Required to enable inbound. A fresh URL rotates the signing secret; `null` removes the endpoint. */
  webhook_url?: string | null;
  retention_days?: number;
  /** One lowercase DNS label. Changing it replaces the inbound DNS records. */
  subdomain?: string;
}

export interface InboundAttachment {
  filename: string;
  content_type: string;
  /** Decoded size, in bytes. */
  size: number;
  /** True when the message failed a virus scan. Its content wasn't kept. */
  quarantined: boolean;
  /** A signed link, valid 15 minutes from the read. Null in a webhook payload and when quarantined. */
  download_url: string | null;
}

/** Each is `pass`, `fail`, `gray`, `processing_failed` or null. */
export interface InboundVerdicts {
  spam: string | null;
  virus: string | null;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

export interface InboundMessage {
  id: string;
  url: string;
  domain_id: string;
  from: string;
  to: string[];
  subject: string;
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
  message_id: string | null;
  in_reply_to: string | null;
  /** Set when `in_reply_to` matches a message this organization sent. Metadata only. */
  outbound_message_id: string | null;
  /** Content isn't inlined; each attachment's `download_url` fetches it. */
  attachments: InboundAttachment[];
  /** A signed link to the message as received. Null in a webhook payload, or when the provider didn't hand it over. */
  raw_download_url: string | null;
  /** The provider's scan results. Null when it doesn't scan. */
  verdicts: InboundVerdicts | null;
  /** Addresses this message was delivered to. */
  address_ids: string[];
  /** Shared by every message in the same conversation, prefixed `thr_`. */
  thread_id: string;
  received_at: string;
  expires_at: string;
  /** With `include: ["delivery"]` on `inbound.list` and `inbound.get`. The newest delivery to the domain's webhook, or null. */
  delivery?: WebhookDelivery | null;
}

export interface ListInboundParams extends ResponseShapeParams<"body" | "delivery"> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
  /** A domain id. */
  domain?: string;
  /** A sent message's id: only replies to it. */
  outbound_message?: string;
}

export interface InboundPage {
  data: InboundMessage[];
  next_cursor: string | null;
}

export type AddressStatus = "active" | "expired" | "revoked";

export interface Address {
  id: string;
  /** `<local_part>@<the domain's inbound host>`. */
  address: string;
  domain_id: string;
  local_part: string;
  label: string | null;
  /** `expired` and `revoked` drop mail silently and count it. Only `revoked` is final. */
  status: AddressStatus;
  expires_at: string;
  message_cap: number | null;
  /** The key that created it. Its endpoints subscribed to `address.received` hear its mail. */
  key_id: string | null;
  counts: {
    received: number;
    /** Delivered on the current UTC day, against `address_daily_message_limit`. */
    received_today: number;
    dropped_expired: number;
    dropped_over_limit: number;
    dropped_virus: number;
    forwarded: number;
  };
  last_received_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Body of `POST /v1/addresses`. Give exactly one of `expires_at` and `expires_in`. */
export interface CreateAddressRequest {
  domain_id: string;
  /** Random when omitted. */
  local_part?: string;
  label?: string;
  expires_at?: string;
  /** Seconds from now. */
  expires_in?: number;
  message_cap?: number;
}

/** Body of `PATCH /v1/addresses/:id`. At least one field is required. */
export interface UpdateAddressRequest {
  expires_at?: string;
  expires_in?: number;
  label?: string | null;
  message_cap?: number | null;
}

export interface ListAddressesParams extends ResponseShapeParams<never> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
  /** A domain id. */
  domain?: string;
  status?: AddressStatus;
}

export interface AddressPage {
  data: Address[];
  next_cursor: string | null;
}

export interface ListAddressMessagesParams extends ResponseShapeParams<"body"> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
  /** Only messages received after this inbound message id. */
  after?: string;
  /** Only messages in this thread id. */
  thread?: string;
  /** Seconds to wait for a message when none matches yet, up to 55. Pass a `signal` with a longer timeout. */
  wait?: number;
}

/** Body of `POST /v1/addresses/:id/reply`. Give at least one of `html` and `text`. */
export interface ReplyFromAddressRequest {
  /** The inbound message to answer. It has to have been delivered to this address. */
  message_id: string;
  /** "Re: " and the original subject when omitted. */
  subject?: string;
  html?: string;
  text?: string;
  cc?: string[];
  attachments?: PouchAttachment[];
  tags?: string[];
}

/** A mailbox an address forwards to. Only `confirmed` targets receive forwards. */
export interface ForwardTarget {
  id: string;
  address_id: string;
  email: string;
  status: "pending" | "confirmed" | "disabled";
  confirmation_sent_at: string | null;
  /** Null unless pending. */
  confirmation_expires_at: string | null;
  confirmed_at: string | null;
  disabled_at: string | null;
  disabled_reason: "bounced" | "complained" | "stopped" | null;
  forwarded_count: number;
  last_forwarded_at: string | null;
  /** The last forward the send path refused. */
  last_failure: { code: string; message: string; at: string } | null;
  created_at: string;
  updated_at: string;
}

export interface ForwardTargetPage {
  data: ForwardTarget[];
  next_cursor: null;
}

/** The `data` of an `address.received` webhook. */
export interface AddressReceivedData extends InboundMessage {
  address: Address;
  /** `spam` and `dmarc` when the provider failed the message on them. */
  flags: string[];
}

export type ProviderStatus = "ready" | "setting_up" | "paused" | "unavailable";

/** The organization's view of a provider. Admins create and rotate them; this is read-only. */
export interface Provider {
  id: string;
  /** `ses`, `mailpace`, `cloudflare` or `mock`. */
  adapter: string;
  name: string;
  /** True for the provider a new domain binds to by default. */
  assigned: boolean;
  status: ProviderStatus;
  backoff_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListProvidersParams extends ResponseShapeParams<"status"> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
}

export interface ProviderPage {
  data: Provider[];
  next_cursor: string | null;
}

export type ExportKind = "log_csv" | "log_ndjson" | "bodies" | "data";

export type ExportStatus = "requested" | "running" | "ready" | "failed" | "expired";

export interface Export {
  id: string;
  kind: ExportKind;
  status: ExportStatus;
  count: number | null;
  filename: string | null;
  /** A signed link, minted fresh on every read. Present only while `status` is `ready`. */
  download_url: string | null;
  error: string | null;
  requested_at: string;
  started_at: string | null;
  ready_at: string | null;
  failed_at: string | null;
  expires_at: string | null;
}

/** Body of `POST /v1/exports`. Every filter is ignored when `kind` is `data`. */
export interface CreateExportRequest {
  kind: ExportKind;
  status?: MessageStatus;
  /** A domain id. */
  domain?: string;
  tag?: string;
  /** ISO 8601 timestamp. */
  since?: string;
  /** ISO 8601 timestamp. */
  until?: string;
}

export interface ListExportsParams extends ResponseShapeParams<never> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
}

export interface ExportPage {
  data: Export[];
  next_cursor: string | null;
}

export interface List {
  id: string;
  domain_id: string;
  name: string;
  double_opt_in: boolean;
  created_at: string;
  updated_at: string;
  /** With `include: ["member_counts"]`. */
  member_counts?: { pending: number; subscribed: number; unsubscribed: number };
}

/** Body of `POST /v1/lists`. */
export interface CreateListRequest {
  domain_id: string;
  name: string;
  /** Whether a new membership must confirm before it can receive a batch. Default `true`. */
  double_opt_in?: boolean;
}

/** Body of `PATCH /v1/lists/:id`. At least one field is required. */
export interface UpdateListRequest {
  name?: string;
  double_opt_in?: boolean;
}

export interface ListListsParams extends ResponseShapeParams<"member_counts"> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
  /** A domain id. */
  domain?: string;
}

export interface ListPage {
  data: List[];
  next_cursor: string | null;
}

export interface DeleteListResult {
  id: string;
  deleted: true;
}

export type MembershipStatus = "pending" | "subscribed" | "unsubscribed";

export interface Membership {
  id: string;
  list_id: string;
  address: string;
  status: MembershipStatus;
  source: "api" | "import" | "manual";
  source_message_id: string | null;
  manual_actor: string | null;
  /** Flat map substituted into `{{name}}` placeholders on a batch send. */
  attributes: Record<string, string>;
  double_opt_in: boolean;
  confirmed_at: string | null;
  confirmed_by: "link" | "import" | "not_required" | null;
  pending_expires_at: string | null;
  unsubscribed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Body of `POST /v1/lists/:id/members`. */
export interface AddMemberRequest {
  address: string;
  attributes?: Record<string, string>;
  /** Default `manual`. `api` is reserved for a subscribe on a send. */
  source?: "import" | "manual";
  /** Import only: marks the membership confirmed, skipping double opt-in. */
  confirmed?: boolean;
}

/** Body of `PATCH /v1/lists/:id/members/:memberId`. */
export interface UpdateMemberRequest {
  /** Replaces the attribute map outright. An empty object clears it. */
  attributes: Record<string, string>;
}

export interface ListMembersParams extends ResponseShapeParams<never> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
  status?: MembershipStatus;
}

export interface MembershipPage {
  data: Membership[];
  next_cursor: string | null;
}

export interface RemoveMemberResult {
  id: string;
  removed: true;
}

/** Body of the import form of `POST /v1/lists/:id/members`. */
export interface ImportMembersRequest {
  /** At most 5000 per call. */
  members: Omit<AddMemberRequest, "source">[];
  /** Marks every imported membership confirmed, skipping double opt-in. */
  confirmed?: boolean;
}

/** An unsubscribed address is never resurrected, and a bad row is reported rather than fatal. */
export interface ImportMembersResult {
  /** Every named membership, new or not. */
  imported: Membership[];
  added: number;
  already_present: number;
  invalid: number;
  errors: { line: number | null; address: string; message: string }[];
}

/** Body of `POST /v1/lists/:id/unsubscribe` and `POST /v1/domains/:id/unsubscribe`. */
export interface UnsubscribeAddressRequest {
  address: string;
}

export interface UnsubscribeResult {
  address: string;
}

export interface BatchRecipient {
  address: string;
  /** Substituted into `{{name}}` placeholders. */
  attributes?: Record<string, string>;
}

/**
 * Body of `POST /v1/batches`. Exactly one of `list` or `recipients`, and at least one of `html`
 * or `text`. Every message carries a signed `List-Unsubscribe`, so there's no `headers` field.
 */
export interface CreateBatchRequest {
  from: string;
  subject: string;
  html?: string;
  text?: string;
  layout?: boolean | LayoutOverride;
  tags?: string[];
  /** A list id to draw recipients from. */
  list?: string;
  /** At most 5000. */
  recipients?: BatchRecipient[];
}

export interface Batch {
  id: string;
  domain_id: string;
  list_id: string | null;
  from: string;
  subject: string;
  tags: string[];
  recipient_count: number;
  /** Recipients skipped: unsubscribed, not yet confirmed, or suppressed. */
  skipped_count: number;
  /** The batch's messages tallied by status. Live — reread for a current picture. */
  counts: Partial<Record<MessageStatus, number>>;
  created_at: string;
}

export type KeyMode = "live" | "test";

export interface Key {
  id: string;
  name: string;
  mode: KeyMode;
  /** Leading characters of the secret, enough to tell two keys apart. Never the secret. */
  secret_prefix: string;
  /** Domains the key may send from. Empty means every domain in the organization. */
  domain_ids: string[];
  rate_limit: number;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** `POST /v1/keys`. `secret` is returned by that call only. */
export interface MintedKey extends Key {
  secret: string;
}

/** Body of `POST /v1/keys`. */
export interface CreateKeyRequest {
  /** Letters, digits and hyphens, unique among the organization's live keys. */
  name: string;
  /** Default `live`. A test key can only create test keys. */
  mode?: KeyMode;
  /** Empty means every domain in the organization. */
  domain_ids?: string[];
  /** Requests a minute, 1-10000. The install's default for new keys when absent: 3000 unless an admin changed it. */
  rate_limit?: number;
}

/** Body of `PATCH /v1/keys/:id`. At least one field is required. */
export interface UpdateKeyRequest {
  name?: string;
  domain_ids?: string[];
  rate_limit?: number;
}

export interface ListKeysParams extends ResponseShapeParams<never> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
  mode?: KeyMode;
  /** `"true"` for revoked keys only, `"false"` for live ones only. Omit for both. */
  revoked?: "true" | "false";
  /** A domain id. Only keys that reach it: limited to it, or to no domain. */
  domain?: string;
}

export interface KeyPage {
  data: Key[];
  next_cursor: string | null;
}

export interface WebhookEndpoint {
  id: string;
  /** The key whose sends produce this endpoint's events. */
  key_id: string;
  url: string;
  events: string[];
  description: string | null;
  disabled: boolean;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
}

/** Returned by `POST /v1/webhook_endpoints` and `POST /v1/webhook_endpoints/:id/rotate_secret`. */
export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  secret: string;
}

/** Body of `POST /v1/webhook_endpoints`. */
export interface CreateWebhookEndpointRequest {
  key_id: string;
  /** An https URL. A private or unroutable address is refused. */
  url: string;
  events: string[];
  description?: string;
}

/** Body of `PATCH /v1/webhook_endpoints/:id`. At least one field is required. */
export interface UpdateWebhookEndpointRequest {
  url?: string;
  events?: string[];
  /** `null` clears it. */
  description?: string | null;
  disabled?: boolean;
}

export interface ListWebhookEndpointsParams extends ResponseShapeParams<never> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
  key_id?: string;
}

export interface WebhookEndpointPage {
  data: WebhookEndpoint[];
  next_cursor: string | null;
}

export interface DeleteWebhookEndpointResult {
  id: string;
  deleted: true;
}

export interface WebhookAttempt {
  id: string;
  attempt: number;
  /** The receiver's HTTP status. Null when it never answered. */
  status_code: number | null;
  error: string | null;
  duration_ms: number;
  created_at: string;
}

export type WebhookDeliveryStatus = "pending" | "succeeded" | "failed" | "exhausted";

export interface WebhookDelivery {
  /** Prefixed `whd_`. The `X-Webhook-Id` header carries it. */
  id: string;
  endpoint_id: string;
  event_type: string;
  /** `failed` is reserved and not written. */
  status: WebhookDeliveryStatus;
  attempt_count: number;
  last_status_code: number | null;
  last_error: string | null;
  /** Null unless `pending`. */
  next_attempt_at: string | null;
  succeeded_at: string | null;
  /** When retrying stops. */
  expires_at: string;
  message_id: string | null;
  created_at: string;
  /** The body that was posted. On `deliveries.get` by default; on `deliveries.list` with `include: ["payload"]`. */
  payload?: Record<string, unknown>;
  /** Oldest first. On `deliveries.get` by default; on `deliveries.list` with `include: ["attempts"]`. */
  attempts?: WebhookAttempt[];
}

export interface ListWebhookDeliveriesParams extends ResponseShapeParams<"payload" | "attempts"> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
}

export interface WebhookDeliveryPage {
  data: WebhookDelivery[];
  next_cursor: string | null;
}

export type ActivityFamily = "key" | "domain" | "suppression" | "settings" | "webhook" | "provider" | "session" | "system" | "list";
export type ActivityOutcome = "success" | "failure" | "neutral";

export interface Activity {
  /** Prefixed `act_`. */
  id: string;
  /** `subject.verb`, such as `domain.added`. */
  action: string;
  family: ActivityFamily;
  outcome: ActivityOutcome;
  /** `id` is null for the worker. `label` is the name when it happened. */
  actor: { type: "user" | "admin" | "api_key" | "worker" | "provider"; id: string | null; label: string };
  applies_to: string | null;
  subject_label: string | null;
  /** A list member's address while the membership exists. */
  address: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface ListActivityParams extends ResponseShapeParams<never> {
  /** At most 200. Default 50. */
  limit?: number;
  cursor?: string;
  family?: ActivityFamily | ActivityFamily[];
  outcome?: ActivityOutcome | ActivityOutcome[];
  /** `type:id` from an entry's `actor`, or `type:label` for the worker. */
  actor?: string | string[];
  /** ISO 8601. */
  since?: string;
}

export interface ActivityPage {
  data: Activity[];
  next_cursor: string | null;
}

export interface Organization {
  id: string;
  name: string;
  /** Read-only here; it addresses dashboard screens. */
  slug: string;
  /** Days a message body stays readable before the worker shreds its key. */
  body_retention_days: number;
  /** The install's ceiling on `body_retention_days`. Bodies stay readable for the smaller of the two. */
  body_retention_max_days: number;
  /** Active addresses the organization may hold. Set by an admin. */
  address_limit: number;
  /** Messages one address may receive per UTC day. Set by an admin. */
  address_daily_message_limit: number;
  suspended: boolean;
  created_at: string;
  updated_at: string;
  /** With `include: ["address_counts"]`. `active` is what `address_limit` caps. */
  address_counts?: { active: number; expired: number; revoked: number };
}

/** Body of `PATCH /v1/organization`. At least one field is required. */
export interface UpdateOrganizationRequest {
  name?: string;
  /** 7 up to the organization's `body_retention_max_days`. */
  body_retention_days?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every code the API documents (`docs/api/conventions.md`), plus room for one it adds later.
 * `code` is stable and safe to branch on; new codes still type-check as `string`.
 */
/** Every code the API returns today. */
export type KnownPouchErrorCode =
  | "organization_key_required"
  | "organization_in_use"
  | "domain_not_at_provider"
  | "insufficient_role"
  | "invalid_json"
  | "invalid_key"
  | "invalid_signature"
  | "key_not_scoped"
  | "admin_key_required"
  | "admin_scope_not_allowed"
  | "organization_suspended"
  | "feature_disabled"
  | "not_found"
  | "invalid_token"
  | "method_not_allowed"
  | "idempotency_conflict"
  | "validation_failed"
  | "recipient_suppressed"
  | "domain_not_verified"
  | "reserved_header"
  | "list_unsubscribe_required"
  | "bulk_not_allowed"
  | "attachment_too_large"
  | "provider_limit"
  | "domain_exists"
  | "domain_unavailable"
  | "domain_in_use"
  | "capability_unavailable"
  | "provider_exists"
  | "provider_in_use"
  | "provider_unassigned"
  | "credentials_rejected"
  | "inbound_disabled"
  | "address_exists"
  | "address_limit_reached"
  | "address_inactive"
  | "forward_not_allowed"
  | "forward_target_exists"
  | "forward_target_limit_reached"
  | "forward_target_not_pending"
  | "reply_not_allowed"
  | "resend_not_allowed"
  | "rate_limit_exceeded"
  | "stream_limit_exceeded"
  | "provider_unavailable"
  | "storage_unavailable";

/** Open-ended, so a code added to the API later still type-checks in an older client. */
export type PouchErrorCode = KnownPouchErrorCode | (string & {});

/**
 * Not one of the API's codes: it never appears in `docs/api/conventions.md`'s code table, so it
 * can't collide with a real one, including one the API adds later. Used only when a response
 * isn't the documented `{ error: { code, message } }` envelope at all — a proxy's 502, an HTML
 * error page, a truncated body — so a caller branching on `code` can't mistake it for
 * `provider_unavailable`, which has its own specific meaning (the email provider is down).
 */
export const UNPARSEABLE_RESPONSE: PouchErrorCode = "sdk_unparseable_response";

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    field?: string;
    detail?: Record<string, unknown>;
  };
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error = (value as { error: unknown }).error;
  return typeof error === "object" && error !== null && "code" in error && "message" in error;
}

export interface PouchErrorOptions {
  status: number;
  field?: string;
  detail?: Record<string, unknown>;
  requestId?: string;
  retryAfter?: number;
}

/**
 * Thrown for every non-2xx response. Carries the same fields the API's error envelope does,
 * plus the HTTP status — so a caller can branch on `code` without parsing the message.
 */
export class PouchError extends Error {
  readonly name = "PouchError";
  readonly code: PouchErrorCode;
  readonly status: number;
  readonly field?: string;
  readonly detail?: Record<string, unknown>;
  /** The response's `X-Request-Id`. Quote it when reporting a problem. */
  readonly requestId?: string;
  /** Seconds to wait before retrying, read from the response's `Retry-After` header when present. */
  readonly retryAfter?: number;

  constructor(code: PouchErrorCode, message: string, options: PouchErrorOptions) {
    super(message);
    this.code = code;
    this.status = options.status;
    this.field = options.field;
    this.detail = options.detail;
    this.requestId = options.requestId;
    this.retryAfter = options.retryAfter;
  }

  static async fromResponse(response: Response): Promise<PouchError> {
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (isErrorEnvelope(body)) {
      return new PouchError(body.error.code, body.error.message, {
        status: response.status,
        field: body.error.field,
        detail: body.error.detail,
        requestId,
        retryAfter,
      });
    }

    return new PouchError(UNPARSEABLE_RESPONSE, `Request failed with status ${response.status}.`, {
      status: response.status,
      requestId,
      retryAfter,
    });
  }
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

/** `X-RateLimit-*` headers, present on every authenticated response. */
export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** Unix seconds. */
  reset: number | null;
}

function readRateLimit(headers: Headers): RateLimitInfo {
  const num = (name: string): number | null => {
    const value = headers.get(name);
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    limit: num("x-ratelimit-limit"),
    remaining: num("x-ratelimit-remaining"),
    reset: num("x-ratelimit-reset"),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface PouchClientOptions {
  /** A key from the dashboard: `sk_live_...` or `sk_test_...`. Test keys deliver nothing. */
  apiKey: string;
  /** Default `https://pouch.email`. Point this at `http://localhost:3100` for local dev. */
  baseUrl?: string;
  /** Override for testing, or to use a fetch implementation other than the global one. */
  fetch?: typeof fetch;
  /** Called after every response that carries rate-limit headers. */
  onRateLimit?: (info: RateLimitInfo) => void;
}

export interface SendEmailOptions {
  /** Deduplicates a retried send. A repeat within 24 hours returns the original message. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Return the body verbatim instead of parsing it as JSON. */
  text?: boolean;
}

const DEFAULT_BASE_URL = "https://pouch.email";

/** `include` and `fields` as the comma-separated query values the API reads. */
function shapeQuery(params?: ResponseShapeParams<string>): { include?: string; fields?: string } {
  return { include: params?.include?.join(","), fields: params?.fields?.join(",") };
}

export class PouchClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onRateLimit?: (info: RateLimitInfo) => void;

  readonly emails: {
    send: (input: SendEmailRequest, options?: SendEmailOptions) => Promise<Message>;
    list: (params?: ListMessagesParams) => Promise<MessagePage>;
    get: (id: string, params?: ResponseShapeParams<"events" | "occurrences" | "stall" | "body" | "rendered" | "resends">) => Promise<Message>;
    /** Send a message again as a new message linked to it. */
    resend: (id: string, options?: SendEmailOptions) => Promise<Message>;
  };

  readonly domains: {
    create: (input: CreateDomainRequest) => Promise<Domain>;
    list: (params?: ListDomainsParams) => Promise<DomainPage>;
    get: (id: string, params?: ResponseShapeParams<"standing" | "reputation" | "dmarc">) => Promise<Domain>;
    update: (id: string, input: UpdateDomainRequest) => Promise<Domain>;
    verify: (id: string) => Promise<Domain>;
    delete: (id: string) => Promise<DeleteDomainResult>;
    /** Read the domain's inbound settings. */
    inbound: (id: string) => Promise<InboundSettings>;
    updateInbound: (id: string, input: UpdateInboundRequest) => Promise<InboundSettings>;
    /** The domain's DMARC aggregate reports, newest first. */
    dmarcReports: (id: string, params?: ListDmarcReportsParams) => Promise<DmarcReportPage>;
    /** Unsubscribe an address from every list on the domain. */
    unsubscribe: (id: string, input: UnsubscribeAddressRequest) => Promise<UnsubscribeResult>;
  };

  readonly inbound: {
    list: (params?: ListInboundParams) => Promise<InboundPage>;
    get: (id: string, params?: ResponseShapeParams<"body" | "delivery">) => Promise<InboundMessage>;
  };

  readonly addresses: {
    create: (input: CreateAddressRequest) => Promise<Address>;
    list: (params?: ListAddressesParams) => Promise<AddressPage>;
    get: (id: string, params?: ResponseShapeParams<never>) => Promise<Address>;
    /** Moves the expiry, label or cap. */
    update: (id: string, input: UpdateAddressRequest) => Promise<Address>;
    /** Revokes the address. Mail to it is dropped and counted from then on. */
    delete: (id: string) => Promise<Address>;
    /** Mail delivered to the address, newest first. With `wait`, holds until a message arrives. */
    messages: (id: string, params?: ListAddressMessagesParams, options?: { signal?: AbortSignal }) => Promise<InboundPage>;
    /** Replies from the address to a message it received, threaded. */
    reply: (id: string, input: ReplyFromAddressRequest, options?: SendEmailOptions) => Promise<Message>;
    /** Forwarding to mailboxes. Each target confirms by a link mailed to it. */
    forwardTargets: {
      add: (id: string, input: { email: string }) => Promise<ForwardTarget>;
      list: (id: string, params?: ResponseShapeParams<never>) => Promise<ForwardTargetPage>;
      get: (id: string, targetId: string, params?: ResponseShapeParams<never>) => Promise<ForwardTarget>;
      remove: (id: string, targetId: string) => Promise<ForwardTarget>;
      /** Mails a new link; the old one stops working. */
      resendConfirmation: (id: string, targetId: string) => Promise<ForwardTarget>;
    };
  };

  readonly providers: {
    list: (params?: ListProvidersParams) => Promise<ProviderPage>;
    get: (id: string, params?: ResponseShapeParams<"status">) => Promise<Provider>;
  };

  readonly reputation: {
    get: () => Promise<Reputation>;
  };

  readonly stats: {
    get: (params?: StatsParams) => Promise<Stats>;
  };

  readonly exports: {
    create: (input: CreateExportRequest) => Promise<Export>;
    list: (params?: ListExportsParams) => Promise<ExportPage>;
    get: (id: string, params?: ResponseShapeParams<never>) => Promise<Export>;
  };

  readonly suppressions: {
    import: (input: ImportSuppressionsRequest) => Promise<ImportSuppressionsResult>;
    list: (params?: ListSuppressionsParams) => Promise<SuppressionPage>;
    /** By id or by address. */
    get: (idOrAddress: string, params?: ResponseShapeParams<never>) => Promise<Suppression>;
    remove: (address: string) => Promise<RemoveSuppressionResult>;
  };

  readonly recipients: {
    get: (address: string, params?: ResponseShapeParams<"history">) => Promise<Recipient>;
  };

  readonly lists: {
    create: (input: CreateListRequest) => Promise<List>;
    list: (params?: ListListsParams) => Promise<ListPage>;
    get: (id: string, params?: ResponseShapeParams<"member_counts">) => Promise<List>;
    update: (id: string, input: UpdateListRequest) => Promise<List>;
    delete: (id: string) => Promise<DeleteListResult>;
    /** The list's members as CSV, the same shape the member import takes. */
    exportCsv: (id: string) => Promise<string>;
    unsubscribe: (id: string, input: UnsubscribeAddressRequest) => Promise<UnsubscribeResult>;
    members: {
      add: (listId: string, input: AddMemberRequest) => Promise<Membership>;
      import: (listId: string, input: ImportMembersRequest) => Promise<ImportMembersResult>;
      list: (listId: string, params?: ListMembersParams) => Promise<MembershipPage>;
      update: (listId: string, memberId: string, input: UpdateMemberRequest) => Promise<Membership>;
      remove: (listId: string, memberId: string) => Promise<RemoveMemberResult>;
    };
  };

  readonly batches: {
    send: (input: CreateBatchRequest) => Promise<Batch>;
    get: (id: string, params?: ResponseShapeParams<"counts">) => Promise<Batch>;
  };

  readonly keys: {
    create: (input: CreateKeyRequest) => Promise<MintedKey>;
    list: (params?: ListKeysParams) => Promise<KeyPage>;
    get: (id: string, params?: ResponseShapeParams<never>) => Promise<Key>;
    update: (id: string, input: UpdateKeyRequest) => Promise<Key>;
    /** Revokes the key. The row stays, so the messages it sent keep naming it. */
    delete: (id: string) => Promise<Key>;
  };

  readonly webhookEndpoints: {
    create: (input: CreateWebhookEndpointRequest) => Promise<WebhookEndpointWithSecret>;
    list: (params?: ListWebhookEndpointsParams) => Promise<WebhookEndpointPage>;
    get: (id: string, params?: ResponseShapeParams<never>) => Promise<WebhookEndpoint>;
    update: (id: string, input: UpdateWebhookEndpointRequest) => Promise<WebhookEndpoint>;
    delete: (id: string) => Promise<DeleteWebhookEndpointResult>;
    rotateSecret: (id: string) => Promise<WebhookEndpointWithSecret>;
    deliveries: {
      list: (id: string, params?: ListWebhookDeliveriesParams) => Promise<WebhookDeliveryPage>;
      get: (id: string, deliveryId: string, params?: ResponseShapeParams<"payload" | "attempts">) => Promise<WebhookDelivery>;
    };
  };

  readonly activity: {
    list: (params?: ListActivityParams) => Promise<ActivityPage>;
    get: (id: string, params?: ResponseShapeParams<never>) => Promise<Activity>;
  };

  readonly organization: {
    get: (params?: ResponseShapeParams<"address_counts">) => Promise<Organization>;
    update: (input: UpdateOrganizationRequest) => Promise<Organization>;
  };

  constructor(options: PouchClientOptions) {
    if (!options.apiKey) throw new Error("PouchClient requires an apiKey.");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    // Bound so it isn't called detached from its receiver — required by some fetch
    // implementations even though Node's undici tolerates the unbound form.
    this.fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!this.fetchImpl) {
      throw new Error("No fetch implementation available. Pass one in PouchClientOptions.fetch.");
    }
    this.onRateLimit = options.onRateLimit;

    this.emails = {
      send: (input, sendOptions) =>
        this.request<Message>("POST", "/v1/emails", {
          body: input,
          signal: sendOptions?.signal,
          headers: sendOptions?.idempotencyKey ? { "Idempotency-Key": sendOptions.idempotencyKey } : undefined,
        }),
      list: (params) =>
        this.request<MessagePage>("GET", "/v1/emails", {
          query: {
            limit: params?.limit,
            cursor: params?.cursor,
            status: Array.isArray(params?.status) ? params.status.join(",") : params?.status,
            domain: params?.domain,
            key: params?.key,
            batch: params?.batch,
            held: params?.held,
            sensitive: params?.sensitive,
            tag: params?.tag,
            to: params?.to,
            reason: params?.reason,
            since: params?.since,
            until: params?.until,
            ...shapeQuery(params),
          },
        }),
      get: (id, params) => this.request<Message>("GET", `/v1/emails/${encodeURIComponent(id)}`, { query: shapeQuery(params) }),
      resend: (id, resendOptions) =>
        this.request<Message>("POST", `/v1/emails/${encodeURIComponent(id)}/resend`, {
          signal: resendOptions?.signal,
          headers: resendOptions?.idempotencyKey ? { "Idempotency-Key": resendOptions.idempotencyKey } : undefined,
        }),
    };

    this.domains = {
      create: (input) => this.request<Domain>("POST", "/v1/domains", { body: input }),
      list: (params) =>
        this.request<DomainPage>("GET", "/v1/domains", {
          query: { limit: params?.limit, cursor: params?.cursor, status: params?.status , ...shapeQuery(params) },
        }),
      get: (id, params) => this.request<Domain>("GET", `/v1/domains/${encodeURIComponent(id)}`, { query: shapeQuery(params) }),
      update: (id, input) => this.request<Domain>("PATCH", `/v1/domains/${encodeURIComponent(id)}`, { body: input }),
      verify: (id) => this.request<Domain>("POST", `/v1/domains/${encodeURIComponent(id)}/verify`),
      delete: (id) => this.request<DeleteDomainResult>("DELETE", `/v1/domains/${encodeURIComponent(id)}`),
      inbound: (id) => this.request<InboundSettings>("GET", `/v1/domains/${encodeURIComponent(id)}/inbound`),
      updateInbound: (id, input) =>
        this.request<InboundSettings>("PATCH", `/v1/domains/${encodeURIComponent(id)}/inbound`, { body: input }),
      dmarcReports: (id, params) =>
        this.request<DmarcReportPage>("GET", `/v1/domains/${encodeURIComponent(id)}/dmarc_reports`, {
          query: { limit: params?.limit, cursor: params?.cursor, ...shapeQuery(params) },
        }),
      unsubscribe: (id, input) =>
        this.request<UnsubscribeResult>("POST", `/v1/domains/${encodeURIComponent(id)}/unsubscribe`, { body: input }),
    };

    this.inbound = {
      list: (params) =>
        this.request<InboundPage>("GET", "/v1/inbound", {
          query: { limit: params?.limit, cursor: params?.cursor, domain: params?.domain, outbound_message: params?.outbound_message, ...shapeQuery(params) },
        }),
      get: (id, params) => this.request<InboundMessage>("GET", `/v1/inbound/${encodeURIComponent(id)}`, { query: shapeQuery(params) }),
    };

    this.addresses = {
      create: (input) => this.request<Address>("POST", "/v1/addresses", { body: input }),
      list: (params) =>
        this.request<AddressPage>("GET", "/v1/addresses", {
          query: { limit: params?.limit, cursor: params?.cursor, domain: params?.domain, status: params?.status , ...shapeQuery(params) },
        }),
      get: (id, params) => this.request<Address>("GET", `/v1/addresses/${encodeURIComponent(id)}`, { query: shapeQuery(params) }),
      update: (id, input) => this.request<Address>("PATCH", `/v1/addresses/${encodeURIComponent(id)}`, { body: input }),
      delete: (id) => this.request<Address>("DELETE", `/v1/addresses/${encodeURIComponent(id)}`),
      messages: (id, params, messagesOptions) =>
        this.request<InboundPage>("GET", `/v1/addresses/${encodeURIComponent(id)}/messages`, {
          query: {
            limit: params?.limit,
            cursor: params?.cursor,
            after: params?.after,
            thread: params?.thread,
            wait: params?.wait,
            ...shapeQuery(params),
          },
          signal: messagesOptions?.signal,
        }),
      reply: (id, input, replyOptions) =>
        this.request<Message>("POST", `/v1/addresses/${encodeURIComponent(id)}/reply`, {
          body: input,
          signal: replyOptions?.signal,
          headers: replyOptions?.idempotencyKey ? { "Idempotency-Key": replyOptions.idempotencyKey } : undefined,
        }),
      forwardTargets: {
        add: (id, input) => this.request<ForwardTarget>("POST", `/v1/addresses/${encodeURIComponent(id)}/forward_targets`, { body: input }),
        list: (id, params) =>
          this.request<ForwardTargetPage>("GET", `/v1/addresses/${encodeURIComponent(id)}/forward_targets`, { query: shapeQuery(params) }),
        get: (id, targetId, params) =>
          this.request<ForwardTarget>("GET", `/v1/addresses/${encodeURIComponent(id)}/forward_targets/${encodeURIComponent(targetId)}`, {
            query: shapeQuery(params),
          }),
        remove: (id, targetId) =>
          this.request<ForwardTarget>("DELETE", `/v1/addresses/${encodeURIComponent(id)}/forward_targets/${encodeURIComponent(targetId)}`),
        resendConfirmation: (id, targetId) =>
          this.request<ForwardTarget>(
            "POST",
            `/v1/addresses/${encodeURIComponent(id)}/forward_targets/${encodeURIComponent(targetId)}/resend_confirmation`,
          ),
      },
    };

    this.providers = {
      list: (params) =>
        this.request<ProviderPage>("GET", "/v1/providers", {
          query: { limit: params?.limit, cursor: params?.cursor, ...shapeQuery(params) },
        }),
      get: (id, params) => this.request<Provider>("GET", `/v1/providers/${encodeURIComponent(id)}`, { query: shapeQuery(params) }),
    };

    this.reputation = {
      get: () => this.request<Reputation>("GET", "/v1/reputation"),
    };

    this.stats = {
      get: (params) =>
        this.request<Stats>("GET", "/v1/stats", {
          query: {
            window: params?.window,
            since: params?.since,
            until: params?.until,
            bucket: params?.bucket,
            mode: params?.mode,
            domain: params?.domain,
            key: params?.key,
            status: Array.isArray(params?.status) ? params.status.join(",") : params?.status,
            ...shapeQuery(params),
          },
        }),
    };

    this.exports = {
      create: (input) => this.request<Export>("POST", "/v1/exports", { body: input }),
      list: (params) =>
        this.request<ExportPage>("GET", "/v1/exports", {
          query: { limit: params?.limit, cursor: params?.cursor, ...shapeQuery(params) },
        }),
      get: (id, params) => this.request<Export>("GET", `/v1/exports/${encodeURIComponent(id)}`, { query: shapeQuery(params) }),
    };

    this.suppressions = {
      import: (input) => this.request<ImportSuppressionsResult>("POST", "/v1/suppressions", { body: input }),
      list: (params) =>
        this.request<SuppressionPage>("GET", "/v1/suppressions", {
          query: {
            limit: params?.limit,
            cursor: params?.cursor,
            reason: params?.reason,
            address: params?.address,
            domain: params?.domain,
            since: params?.since,
            until: params?.until,
            ...shapeQuery(params),
          },
        }),
      get: (idOrAddress, params) =>
        this.request<Suppression>("GET", `/v1/suppressions/${encodeURIComponent(idOrAddress)}`, { query: shapeQuery(params) }),
      remove: (address) =>
        this.request<RemoveSuppressionResult>("DELETE", `/v1/suppressions/${encodeURIComponent(address)}`),
    };

    this.recipients = {
      get: (address, params) =>
        this.request<Recipient>("GET", `/v1/recipients/${encodeURIComponent(address)}`, { query: shapeQuery(params) }),
    };

    this.lists = {
      create: (input) => this.request<List>("POST", "/v1/lists", { body: input }),
      list: (params) =>
        this.request<ListPage>("GET", "/v1/lists", {
          query: { limit: params?.limit, cursor: params?.cursor, domain: params?.domain, ...shapeQuery(params) },
        }),
      get: (id, params) => this.request<List>("GET", `/v1/lists/${encodeURIComponent(id)}`, { query: shapeQuery(params) }),
      update: (id, input) => this.request<List>("PATCH", `/v1/lists/${encodeURIComponent(id)}`, { body: input }),
      delete: (id) => this.request<DeleteListResult>("DELETE", `/v1/lists/${encodeURIComponent(id)}`),
      exportCsv: (id) => this.request<string>("GET", `/v1/lists/${encodeURIComponent(id)}/export`, { text: true }),
      unsubscribe: (id, input) =>
        this.request<UnsubscribeResult>("POST", `/v1/lists/${encodeURIComponent(id)}/unsubscribe`, { body: input }),
      members: {
        add: (listId, input) =>
          this.request<Membership>("POST", `/v1/lists/${encodeURIComponent(listId)}/members`, { body: input }),
        import: (listId, input) =>
          this.request<ImportMembersResult>("POST", `/v1/lists/${encodeURIComponent(listId)}/members`, { body: input }),
        list: (listId, params) =>
          this.request<MembershipPage>("GET", `/v1/lists/${encodeURIComponent(listId)}/members`, {
            query: { limit: params?.limit, cursor: params?.cursor, status: params?.status, ...shapeQuery(params) },
          }),
        update: (listId, memberId, input) =>
          this.request<Membership>(
            "PATCH",
            `/v1/lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(memberId)}`,
            { body: input },
          ),
        remove: (listId, memberId) =>
          this.request<RemoveMemberResult>(
            "DELETE",
            `/v1/lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(memberId)}`,
          ),
      },
    };

    this.batches = {
      send: (input) => this.request<Batch>("POST", "/v1/batches", { body: input }),
      get: (id, params) => this.request<Batch>("GET", `/v1/batches/${encodeURIComponent(id)}`, { query: shapeQuery(params) }),
    };

    this.keys = {
      create: (input) => this.request<MintedKey>("POST", "/v1/keys", { body: input }),
      list: (params) =>
        this.request<KeyPage>("GET", "/v1/keys", {
          query: { limit: params?.limit, cursor: params?.cursor, mode: params?.mode, revoked: params?.revoked, domain: params?.domain, ...shapeQuery(params) },
        }),
      get: (id, params) => this.request<Key>("GET", `/v1/keys/${encodeURIComponent(id)}`, { query: shapeQuery(params) }),
      update: (id, input) => this.request<Key>("PATCH", `/v1/keys/${encodeURIComponent(id)}`, { body: input }),
      delete: (id) => this.request<Key>("DELETE", `/v1/keys/${encodeURIComponent(id)}`),
    };

    this.webhookEndpoints = {
      create: (input) => this.request<WebhookEndpointWithSecret>("POST", "/v1/webhook_endpoints", { body: input }),
      list: (params) =>
        this.request<WebhookEndpointPage>("GET", "/v1/webhook_endpoints", {
          query: { limit: params?.limit, cursor: params?.cursor, key_id: params?.key_id , ...shapeQuery(params) },
        }),
      get: (id, params) => this.request<WebhookEndpoint>("GET", `/v1/webhook_endpoints/${encodeURIComponent(id)}`, { query: shapeQuery(params) }),
      update: (id, input) =>
        this.request<WebhookEndpoint>("PATCH", `/v1/webhook_endpoints/${encodeURIComponent(id)}`, { body: input }),
      delete: (id) =>
        this.request<DeleteWebhookEndpointResult>("DELETE", `/v1/webhook_endpoints/${encodeURIComponent(id)}`),
      rotateSecret: (id) =>
        this.request<WebhookEndpointWithSecret>(
          "POST",
          `/v1/webhook_endpoints/${encodeURIComponent(id)}/rotate_secret`,
        ),
      deliveries: {
        list: (id, params) =>
          this.request<WebhookDeliveryPage>("GET", `/v1/webhook_endpoints/${encodeURIComponent(id)}/deliveries`, {
            query: { limit: params?.limit, cursor: params?.cursor, ...shapeQuery(params) },
          }),
        get: (id, deliveryId, params) =>
          this.request<WebhookDelivery>(
            "GET",
            `/v1/webhook_endpoints/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}`,
            { query: shapeQuery(params) },
          ),
      },
    };

    this.activity = {
      list: (params) =>
        this.request<ActivityPage>("GET", "/v1/activity", {
          query: {
            limit: params?.limit,
            cursor: params?.cursor,
            family: Array.isArray(params?.family) ? params.family.join(",") : params?.family,
            outcome: Array.isArray(params?.outcome) ? params.outcome.join(",") : params?.outcome,
            actor: Array.isArray(params?.actor) ? params.actor.join(",") : params?.actor,
            since: params?.since,
            ...shapeQuery(params),
          },
        }),
      get: (id, params) => this.request<Activity>("GET", `/v1/activity/${encodeURIComponent(id)}`, { query: shapeQuery(params) }),
    };

    this.organization = {
      get: (params) => this.request<Organization>("GET", "/v1/organization", { query: shapeQuery(params) }),
      update: (input) => this.request<Organization>("PATCH", "/v1/organization", { body: input }),
    };
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...options.headers,
    };

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });

    if (this.onRateLimit && response.headers.has("x-ratelimit-limit")) {
      this.onRateLimit(readRateLimit(response.headers));
    }

    if (!response.ok) throw await PouchError.fromResponse(response);
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    if (options.text) return text as T;
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
