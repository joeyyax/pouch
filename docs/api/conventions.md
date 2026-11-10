# API conventions

The API is the product. These rules keep it consistent across increments.

## Base

- Versioned under `/v1/`. A breaking change is a new version, never a changed field.
- JSON in, JSON out. `Content-Type: application/json` on every response, errors included.
- Authentication is `Authorization: Bearer <key>`. Keys are opaque strings with a short prefix that identifies test-mode keys at a glance.
- Every resource has an id. Ids are opaque strings with a type prefix — see the table below.
- A message carries `url`, the address it can be read at.

### Id prefixes

| Prefix | Resource |
|---|---|
| `msg_` | Message |
| `dom_` | Domain |
| `key_` | API key |
| `evt_` | Message event |
| `inb_` | Inbound message |
| `adr_` | Address |
| `thr_` | Thread |
| `fwt_` | Forward target |
| `lst_` | List |
| `bat_` | Batch |
| `lmb_` | List membership |
| `dun_` | Domain unsubscribe |
| `org_` | Organization |
| `pac_` | Provider |
| `sup_` | Suppression |
| `whk_` | Webhook endpoint |
| `whd_` | Webhook delivery |
| `wha_` | Webhook attempt |
| `act_` | Activity |
| `exp_` | Export |
| `dmr_` | DMARC report |

The full list lives in `lib/ids.ts`; a new prefix lands here in the PR that introduces it.

## Keys

A key has one of two scopes.

- **Organization** (the default): created on an organization's Keys screen. It reaches its organization's routes, limited to its domains when it has any.
- **Admin:** created by an admin at Admin settings → API keys, and only there. It belongs to no organization, is always live and can't be limited to domains. It reaches `/v1/admin/*` and nothing else: any other `/v1` route returns `403 organization_key_required`, and so does SMTP AUTH. An organization key on an admin route returns `403 admin_key_required`.

Admin keys don't expire. Each one records its creator. Demoting or deleting the creator revokes their admin keys, and a request with an admin key whose creator isn't an admin returns `401 invalid_key` even if the key isn't revoked. Their organization keys survive that — the two axes are separate.

**A key carries its organization's authority, not a person's role.** It records who minted it, never who's calling with it, so nothing here enforces `owner` or `member` — those govern the dashboard only. A read-only key would be a scope on the key, not a role. See docs/decisions.md, "Admin is service-wide; an organization has owners and members".

Organization keys have their own routes — see "Keys API" below. Admin keys don't: an admin mints those in the dashboard only, so a leaked admin key can't make more. Secrets are shown once, and provider credentials are never returned to any key. The admin routes are in `docs/api/admin.md`.

## Keys API

| Route | Does |
|---|---|
| `POST /v1/keys` | Takes `name`, `mode`, `domain_ids` and `rate_limit`. Returns `201` with the key and its `secret`, which appears in this response and nowhere else. |
| `GET /v1/keys` | Lists the organization's keys, newest first, with `limit`, `cursor`, `mode`, `revoked` and `domain`. `domain` is a domain id and lists the keys that reach it: limited to it, or to no domain. Admin keys are never listed. |
| `GET /v1/keys/:id` | One key. |
| `PATCH /v1/keys/:id` | Takes any of `name`, `domain_ids` and `rate_limit`. Never the secret: a leaked key is revoked and re-minted, not patched. A revoked key can't be edited. |
| `DELETE /v1/keys/:id` | Revokes the key and returns it with `revoked_at` set. The row stays, so the messages it sent keep naming it; the secret stops authenticating at once. |

A key response carries `id`, `name`, `mode`, `secret_prefix`, `domain_ids`, `rate_limit`, `last_used_at`, `revoked_at` and `created_at`. `secret` is on the create response only.

`last_used_at` is the last request that authenticated with the key — any route, read or write, over HTTP, MCP or SMTP AUTH, whatever the response was. It's written at most once a minute per key, so a key in constant use reads up to a minute stale. See docs/decisions.md, "`last_used_at` is every authenticated request, written once a minute".

Two rules keep these routes from being an escalation step:

- **Every route needs a key with no domain scope.** A scoped key returns `403 key_not_scoped`, since it could otherwise mint one that isn't scoped.
- **A key mints only in its own mode.** A test-mode key asking for `mode: "live"` gets `422 validation_failed` on `mode`. A sandbox key handed to a contractor stays a sandbox key.
- **A key manages only keys of its own mode.** A test key lists, reads, edits and revokes test keys and their webhook endpoints; a live key reads as `404`.

## Webhook endpoints API

| Route | Does |
|---|---|
| `POST /v1/webhook_endpoints` | Takes `key_id`, `url`, `events` and an optional `description`. Returns `201` with the endpoint and its signing `secret`, shown once. |
| `GET /v1/webhook_endpoints` | Lists the organization's key-scoped endpoints, newest first, with `limit`, `cursor` and `key_id`. |
| `GET /v1/webhook_endpoints/:id` | One endpoint. |
| `PATCH /v1/webhook_endpoints/:id` | Takes any of `url`, `events`, `description` and `disabled`. |
| `DELETE /v1/webhook_endpoints/:id` | Removes the endpoint. |
| `POST /v1/webhook_endpoints/:id/rotate_secret` | Mints a new signing secret and returns it once. The old one stops verifying immediately, so publish the new one before the next event. |
| `GET /v1/webhook_endpoints/:id/deliveries` | The endpoint's delivery log, newest first, with `limit` and `cursor`. |
| `GET /v1/webhook_endpoints/:id/deliveries/:deliveryId` | One delivery, with the payload that was posted and every attempt. |

An endpoint response carries `id`, `key_id`, `url`, `events`, `description`, `disabled`, `last_success_at`, `last_failure_at` and `created_at`. `secret` is on the create and rotate responses only — there's no reveal route, and a lost secret is rotated rather than read back. A domain's inbound endpoint isn't one of these; it has its own door at `PATCH /v1/domains/:id/inbound`.

A delivery carries `id` (the `X-Webhook-Id` it was posted with), `endpoint_id`, `event_type`, `status`, `attempt_count`, `last_status_code`, `last_error`, `next_attempt_at`, `succeeded_at`, `expires_at`, `message_id` and `created_at`. `status` is `pending` while attempts remain, then `succeeded` or `exhausted`; `next_attempt_at` is null unless it's `pending`. `payload` is the body as posted, frozen at enqueue, and an `address.received` payload loses `text` and `html` when the message is purged, the same as the stored copy a retry sends. `attempts` lists `{ id, attempt, status_code, error, duration_ms, created_at }`, oldest first.

These routes need a key with no domain scope too: an endpoint hears every event its key produces, across every domain that key reaches.

## Organization API

| Route | Does |
|---|---|
| `GET /v1/organization` | The key's own organization. A singleton, not a list. |
| `PATCH /v1/organization` | Takes `name`, `body_retention_days`, or both. |

The response carries `id`, `name`, `slug`, `body_retention_days`, `body_retention_max_days`, `address_limit`, `address_daily_message_limit`, `suspended`, `created_at` and `updated_at`. The two address limits are set by an admin (`docs/api/admin.md`). `slug` is read-only here — it addresses dashboard screens. Lowering `body_retention_days` shortens how long every body stays readable, existing ones included. It takes 7 up to `body_retention_max_days`, the install's ceiling: 365 unless an admin changed it. Above it is `422 validation_failed` with `detail.max`. When an admin lowers the ceiling below the organization's value, the value stays and bodies stay readable for the ceiling.

Both need a key with no domain scope, since the settings are organization-wide. Suspending or releasing an organization stays admin-only (`docs/api/admin.md`); this route reports the state and can't change it.

## Naming

- `snake_case` for fields. `from`, `reply_to`, `provider_message_id`.
- Timestamps are ISO 8601 in UTC, suffixed `_at`: `created_at`, `delivered_at`.
- Booleans read as states, not questions: `verified`, not `is_verified`.
- Lists are plural nouns: `/v1/emails`, `/v1/domains`. Detail is `/v1/emails/:id`.
- The lifecycle field is `status` and its values are the lifecycle words, lowercase.

## Sending

`POST /v1/emails` accepts:

| Field | Type | Notes |
|---|---|---|
| `from` | string | `Name <address>` or bare address. Domain must be verified and in the key's scope. |
| `to` | string or string[] | Required. |
| `cc`, `bcc` | string or string[] | |
| `reply_to` | string or string[] | |
| `subject` | string | Required. |
| `html`, `text` | string | At least one. |
| `headers` | object | Custom headers. Reserved headers are rejected with a `422`, as are any headers when the domain's provider can't carry them. |
| `tags` | string[] | Free-form, filterable in the dashboard. |
| `attachments` | array of `{ filename, content, content_type }` | `content` is base64. Size limits come from the domain's provider. |
| `layout` | boolean or object | Wrap `html` in the domain's layout, which `GET /v1/domains/:id` reads and `PATCH` sets. The domain must have one, or this is a `422`. `true` uses the layout as configured; an object overrides one or more of its fields for this send only — `name`, `logo`, `accent`, `footer`, all optional, falling back to the domain's value for anything omitted. `logo` must be an https URL — there's no upload path through this API. Default `false`. |
| `subscribe` | string[] | List ids to add every address in `to` to, at accept time, as an `api` membership recording this message's id. Each list must be on the sending domain. The only door a send can grow a list through — see docs/product/brief.md, "Lists". |
| `sensitive` | boolean | Withhold the body from every read once accepted. See "Sensitive messages". Default `false`. |

Response is `202` with the message id, `status: "queued"` and `warnings`, and a `Location` header matching the message's `url`. Acceptance means persisted, not delivered.

`warnings` is an array, empty when the recipients' history is clean. Each entry names one recipient with a history worth a second look — it's a hint, not a refusal: the message is still accepted and queued regardless of what's in it. It's a snapshot taken at accept time and never recomputed, so it can go stale as later events land.

| Code | Fires when | `detail` |
|---|---|---|
| `previously_bounced` | The recipient has bounced, with nothing delivered since. | `bounce_count`, `last_bounced_at` |
| `previously_complained` | The recipient has complained, with nothing delivered since. | `complaint_count`, `last_complained_at` |
| `frequent_deferrals` | The recipient has been deferred repeatedly since the last delivery. | `deferred_count`, `last_deferred_at` |

Every entry also carries `address` and `message`, a one-sentence explanation. `warnings` rides along on the message wherever the message itself does — including the `data` object of every `email.delivered`, `email.bounced` and `email.complained` webhook payload, since that's the same message shape `GET /v1/emails/:id` returns.

`GET /v1/emails` lists the key's messages, newest first, with `limit`, `cursor`, `status`, `domain`, `key`, `batch`, `held`, `sensitive`, `tag`, `to`, `reason`, `since` and `until`. `status` takes one status or several, comma-separated. `key` is a key id and narrows within the caller's scope, never past it. `batch` is a batch id. `held=true` returns queued messages a paused domain or a holding suspension is keeping back, and `held=false` the rest. `sensitive=true` returns messages whose body is withheld, and `sensitive=false` the rest. A message carries `key_id`, the key that sent it, or `null` for mail sent without one. `to` matches a recipient in to, cc or bcc on its normalized form. `reason` matches a bounce or complaint whose reason is exactly that string, the same text `GET /v1/stats` returns in `reasons`.

A message also carries `sensitive`, true when its body is withheld from every read, and what the send asked for and where it stands in the queue: `headers` (custom headers as accepted), `layout` (`false`, `true` or the override object, as sent), `batch_id`, `next_attempt_at` (when the service next tries to send it; null unless `queued`, and a past time means it's due), `abandoned_at` (set when the provider took a sent message and never reported back; `status` stays `sent`) and `size`: `{ body_bytes, attachment_bytes }`, recorded at accept time. `body_bytes` is the UTF-8 size of the html and text parts as accepted, before the domain's layout and counting a text part generated from html. `attachment_bytes` is the decoded attachment size, `0` with none. Both are `null` on a message accepted before sizes were recorded, so an unknown size never reads as `0`. `GET /v1/emails/:id` returns one message, with its full event history (oldest first; events at the same instant read in lifecycle order, then by id) and a `stall` field: `null` unless the message is `queued` and held, in which case it's `{ kind, reason, message, stalled_at }` — `reason`, `message` and `stalled_at` the same shape as a domain response's `stall`, so a caller polling a stuck message can tell "queued, waiting on capacity" from "queued, held" without a new lifecycle status. `kind` says what's holding it: `domain` when the message's own domain is paused, `organization` when its organization is suspended under `reputation` or `provider` (see "Suspending an organization"). Under `reputation` the reasons are the domain pause reasons, evaluated over the organization's domains summed; under `provider` the reason is `provider_paused`. Both routes take `include` and `fields`: `include=body` returns what was accepted, `include=rendered` what the recipient got and `include=occurrences` what happened without changing the status (see "Include and fields").

### Resending

`POST /v1/emails/:id/resend` takes no body and sends the message again as a new one: the original's recipients, from, subject, body, attachments, tags, headers and layout, with `resent_from` set to the original's id. The response is the one `POST /v1/emails` gives. The copy goes through the same accept path, so suppression, domain verification, key scope, fan-out, provider limits and `Idempotency-Key` all apply, and it records its own `size`, events and delivery history. It keeps the original's test mode.

- It needs the same key a send from that domain does. A message in another organization is a `404`.
- The original's body has to be readable. A withheld, shredded or expired body returns `422 resend_not_allowed` with `detail.reason`, and so does a bulk original whose recipient has unsubscribed from its domain since (`unsubscribed`). Storage not answering returns `503 storage_unavailable`; retry it.
- Every message carries `resent_from`, null for an original send. `resends` lists the copies as `{ id, status, created_at }`, oldest first: in the default on `GET /v1/emails/:id` and with `include=resends` on the list.

### Sensitive messages

`"sensitive": true` on `POST /v1/emails` withholds the body. The message is stored and sent as any other, and then:

- No read returns the body: `include=body` and `include=rendered` answer `body: null` with `body_unavailable.reason` `withheld` and the message `Body withheld: it was marked as sensitive.` MCP, exports, attachment downloads and the dashboard refuse it too.
- The body's key is shredded once the message leaves `queued`, whatever the organization's retention says.
- A resend returns `422 resend_not_allowed` with `detail.reason` `withheld`.
- The message carries `sensitive: true`. Pouch's own credential mail, such as a sign-in link, carries it too.

Over SMTP, a `X-Pouch-Sensitive: 1` header does the same. The header is stripped before sending, and any other value leaves the message unmarked. On `POST /v1/emails` the header is a `422 reserved_header`; use the field.

Pouch never reads a body to decide this. The sender marks it, and marking every message is allowed. `POST /v1/batches` doesn't take it.

## Domains

A domain is a domain mail sends from, bound to one provider. The caller sees which provider by id, and never the provider's credentials or console.

| Route | Does |
|---|---|
| `POST /v1/domains` | Takes `name` and an optional `provider_id`, which defaults to the organization's assigned provider; with none assigned it returns `provider_unassigned`. Creates the domain at the provider and returns `201` with the DNS records to publish. Only a key with no domain scope may add a domain; a scoped key returns `403`, since it couldn't read what it created. |
| `GET /v1/domains` | Lists the key's domains, newest first, with `limit`, `cursor` and `status`. |
| `GET /v1/domains/:id` | One domain. `include=reputation` adds the reputation detail (see "Reputation standing"). `include=dmarc` adds the DMARC read (see "DMARC"). |
| `POST /v1/domains/:id/verify` | Asks the provider where verification stands, then returns the domain with `missing_records` refreshed and `dmarc` read. |
| `PATCH /v1/domains/:id` | Takes any of `provider_id`, `bulk_allowed` and `layout`. `provider_id` records a pending move to that provider and returns the domain with `pending` set to the new DNS records to publish; `null` cancels a move in progress. `bulk_allowed` turns bulk sending on or off for this domain; turning it on is refused with `bulk_not_allowed` when the domain's provider has no bulk API or the domain has no valid DMARC record. `layout` sets the frame (below). |
| `DELETE /v1/domains/:id` | Removes a domain nothing has sent from. |
| `GET /v1/domains/:id/dmarc_reports` | The domain's DMARC aggregate reports, newest first (see "DMARC reports"). |

A domain response carries `id`, `name`, `status`, `dns_records`, `missing_records`, `setup`, `errors`, `verified_at`, `last_checked_at`, `created_at`, `provider_id`, `pending`, `stall`, `bulk_allowed`, `layout`, `standing` and `standing_reason`. `provider_id` is the provider the domain sends through now. `setup` lists what the domain's provider can't finish through its API, worded for the organization: a step in the provider's console, such as Mailpace's webhook, credential and removal, reads as waiting on an admin, since only an admin reaches it. Event delivery on a provider that wires its own, such as SES, is the exception: it clears once the subscription is confirmed, and a verify call retries it. The dashboard shows the same steps. `status` is `pending`, `verified` or `failed`; a `failed` domain carries the provider's reasons in `errors`, cleared on the next verified answer. Pending and failed domains are both re-checked in the background, so fixing the DNS restores a failed domain without another verify call. Only a verified domain can send. `bulk_allowed` is `false` on every domain until an admin turns it on — see "Bulk" below.

### DMARC

`dns_records` ends with a recommended TXT at `_dmarc.<domain>` carrying `v=DMARC1; p=none;` and `required: false`: a policy that watches and changes nothing about delivery, which is all Gmail and Yahoo ask of a bulk sender. Once the admin has set up a report host and its records check out, the record also carries `rua=mailto:<token>@<host>`, the domain's own report address (see "DMARC reports"). An organization that turned reports off gets the record without it. A record already at that name, such as one the provider supplied, replaces it. `missing_records` stays the provider's answer and never lists it.

`dmarc` reads the record live: on `POST /v1/domains/:id/verify` and on `GET /v1/domains/:id?include=dmarc`. The list and the default read leave it out, since a page of domains would cost a page of lookups. It looks at `_dmarc.<domain>`, then at the organizational domain's, which is where a subdomain without its own record is governed from.

- `status`: `found`, `missing`, `multiple` (receivers ignore every record when there's more than one), `invalid` (no usable `p`, or not a tag list) or `unresolved` (the lookup didn't answer, so the record may be there).
- `record_name`, `source` (`domain` or `organizational`) and `record`: where it was read and what it says.
- `policy`, `subdomain_policy`, `percent`, `rua`, `ruf`, `adkim` and `aspf`: the tags, with `percent` 100 and both alignments `relaxed` by default. Null or empty without a usable record. A record with a `rua` and no usable `p` reads as `p=none`, as receivers treat it.
- `alignment`: `{ dkim, spf, passes }`, each side with the `domains` the setup authenticates as, the `mode` and whether it `aligned`. DKIM signs as the domain its selector record sits under; SPF is read from the names holding an SPF record. DMARC passes when either aligns, so `passes` is `true` unless both fail.
- `findings`: `{ kind, severity, message }`. `severity` is `problem` for `missing`, `multiple_records`, `unparseable` and `alignment_fails`, and `note` for `monitoring_only` (`p=none`), `unanswered`, `dkim_not_aligned`, `spf_not_aligned` and `no_report_address` (the domain's own record lacks its report address).
- `recommended`: the record to publish at `_dmarc.<domain>`. With no usable record it's the recommended one. With a record that lacks the domain's report address it's that record with the address added to `rua`, every other tag kept. Null when nothing needs to change, and when the record is read from the organizational domain.

A missing record never blocks verification: sending works without one. It blocks one thing, turning `bulk_allowed` on, because Gmail and Yahoo reject bulk mail from a domain without a DMARC record. `PATCH /v1/domains/:id` returns `422 bulk_not_allowed` with `detail.reason: "dmarc_required"` for `missing`, `multiple` and `invalid`. A record at any policy passes, `p=none` included, and an `unresolved` lookup passes: only a definite absence refuses. A domain already on isn't checked again, and turning bulk off is always accepted.

Under relaxed alignment, which is DMARC's default, the MAIL FROM subdomain `mail.<domain>` aligns with the domain. Under `aspf=s` it doesn't, and DKIM, which signs as the domain itself, carries DMARC alone. A record asking for `adkim=s` alongside `aspf=s` still passes the default SES setup. Every adapter's DKIM records sit under the domain itself, so no default setup fails strict alignment on both sides.

### DMARC reports

`GET /v1/domains/:id/dmarc_reports` lists the aggregate reports mailbox providers sent to the domain's report address, newest first by the end of the period each covers, with `limit` and `cursor`. A report is `{ id, domain_id, reporter, reporter_email, report_id, begins_at, ends_at, policy, message_count, received_at }`; `include=records` adds its rows, most messages first.

Each row is `{ source_ip, count, origin, disposition, dkim, spf, header_from, envelope_from, dkim_results, spf_results }`. `dkim` and `spf` are the receiver's aligned verdicts, `pass` or `fail`, and DMARC passes when either does. `origin` says who sent it, read from the domain's own records rather than provider address ranges:

- `provider`: signed with the DKIM key the domain's provider publishes, or sent from its envelope host, and that passed.
- `other`: passed DMARC without the provider. A sender the domain authorizes in its own DNS.
- `forwarded`: a DKIM signature aligned with the domain broke on the way, as forwarding and mailing lists do.
- `unauthenticated`: failed DMARC and carried nothing of the domain's.

The list is empty until the admin sets up a report host and the domain publishes its address. A report about another domain, or with no rows whose header From is this domain, isn't stored, and a second copy of a reporter's report id is dropped. Reports are kept as long as the organization's `body_retention_days`.

### Layout

`layout` is the frame a send with `layout: true` is wrapped in, and what a send's `layout` overrides fall back to: `{ name, logo, accent, footer }`, or `null` when the domain has none. The names match a send's overrides. `name` is who the mail is from, the logo's alt text and what shows in its place; `logo` is an https URL or `null`; `accent` is a six-digit hex color; `footer` is one or two lines.

`PATCH /v1/domains/:id` with `layout` sets it. Fields left out keep their stored value, so `{ "layout": { "accent": "#1d46f5" } }` changes one color. On a domain without a layout, `name`, `accent` and `footer` are required. `{ "layout": null }` removes it, and sends with `layout: true` then return `422`. Each field sent is checked with the dashboard's rules, a new layout is checked whole, and a failure names the field as `layout.<name>`. The layout applies before `bulk_allowed` and `provider_id`, so a refused layout changes nothing. A change is recorded in the activity log; a patch that changes nothing isn't.

Uploading a logo file is dashboard-only: the API takes a URL the caller already serves. A logo the dashboard uploaded is deleted when a layout from either surface stops using it.

## Pausing a domain

A domain whose bounce or complaint activity crosses our own action point — half of what AWS SES reviews an account at — pauses: the domain keeps accepting sends, but the worker stops releasing its queued ones until a person clears the hold. `POST /v1/emails` still returns `202` for a paused domain; nothing is rejected, and nothing already queued is lost.

`stall` on a domain response is `null` when it's sending normally, or `{ reason, message, stalled_at }` when it's held. `reason` is one of `bounce_rate`, `bounce_trend`, `bounce_count`, `complaint_rate`, `complaint_trend`, `complaint_count` — a level crossed, a rate projected to cross one soon, or a small absolute count too low-volume for a rate to mean anything. A count reason only fires once the domain has resolved at least 10 messages — below that, even 3 bounces or 1 complaint is as likely a fluke as abuse, and neither guard fires. `message` is the sentence the dashboard shows, or "This domain is paused." for a hold written without its numbers. A domain is paused when it has `stalled_at` and a reason, the same test the worker holds mail on. A pause clears only by a person, never on its own: a rate recovering because sending paused isn't evidence the underlying problem is fixed.

A domain entering the paused state pushes an admin alert (ntfy) naming the domain, the reason and the number that tripped it — never email, since the thing that would send it is what stopped. It fires once per pause, not once per queue check.

## Reputation standing

Every domain and the organization have one standing: `healthy`, `watch`, `at_risk` or `paused`. It's computed when read, from the same 7-day counts the reputation guard uses, so it's current on every call. `watch` and `at_risk` never hold mail; `paused` means the domain is paused or the organization is suspended.

A domain response carries `standing` and `standing_reason`, one sentence on why it isn't healthy, `null` when it is. `GET /v1/domains` computes every domain's standing in one read, not one per domain.

`GET /v1/domains/:id?include=reputation` adds `reputation`, what the domain's reputation page shows, or `null` until the domain has verified:

- `findings`: every finding behind the standing, worst first, as `{ kind, standing, title, body, action }`. `standing_reason` is the first one's.
- `windows`: 7 days, then 30, each with `bounce` and `complaint` readings: `count`, `denominator` (resolved messages), `rate` (`null` below 50 resolved), `previous_rate` and `delta` against the window before, and the `watch_line`, `at_risk_line`, `stall_line`, `provider_review_line` and `provider_pause_line` it's measured against.
- `reasons`: the receiving servers' words for bounces and complaints over 30 days, grouped, as `{ status, reason, kind, count, last_at }`.
- `signals`: the last `window_hours` against the `baseline_days` before: `recent_total`, `baseline_total`, `recent_recipients`, `first_time_recipients` and `suppressed_rejections`. `null` with nothing to read.
- `blocklists`: `state` is `on`, `off` (the install has no Spamhaus key) or `paused` (the key fails or the day's budget is spent). `lists` has one entry per list with `listed`, `code`, `reason`, `listed_since`, `expires_at`, `checked_at` and `last_error_at`; `links` lists listed domains the last day's mail linked to.
- `provider_findings`: open findings SES reports on the organization's tenant, as `{ type, impact, description, opened_at }`.
- `tenant_volume`: SES's own `sends`, `bounces` and `complaints` for the organization's tenant over `days`, cached for an hour. `null` off a tenant or when SES can't be read.

The standing is computed once for the read, so `standing` and `reputation.findings` always agree. The list doesn't take it: a page of domains would cost a page of these reads.

`GET /v1/reputation` returns the organization's standing, for a check before a bulk send. It's a singleton under the key's organization, not a list, and it takes the same shape the `reputation_changed` webhooks post: `{ object: "reputation", subject, standing, reason, findings, domains }`. `domains` lists the ones that aren't healthy, worst first. The organization reads `at_risk` when a domain is paused. Like the organization webhook, it needs a key with no domain scope; a scoped key returns `403 key_not_scoped`.

## Stats

`GET /v1/stats` counts the messages accepted in a window against the window before it: what the dashboard's overview, volume strips and domain and key trends read.

- **Window:** `window` is `24h`, `7d`, `30d` (the default) or `90d`, ending now. `since` and an optional `until` set one instead, 90 days at most. The previous window is the same length, ending at `since`.
- **Buckets** are UTC hours or UTC days (`bucket`), oldest first, with empty ones included. The first starts at the hour or day `since` falls in. A screen in another zone sums hours into its own days.
- **What counts:** `domain`, `key` and `status` narrow it. `status` narrows the counts and every bucket total; `latency`, `attempts` and `reasons` cover every status. Test mail is left out unless `mode` is `test` or `all`. A test key counts test mail only and gets `403 key_not_scoped` asking for more; a domain-scoped key counts its domains, and naming another is `403 key_not_scoped`.
- **Counts by status** are the status each message has now. `abandoned` is the part of `sent` the provider never reported on.
- **Freshness:** the last day is counted when read. Older hours come from an hourly rollup, so a bounce reported days after the send shows within an hour of arriving.
- **Latency** comes from hourly histograms: p50, p95 and p99 within 2.2% of the exact value, and exact when every sample is the same.
- **Queue** (`include=queue`) is the queue now, whatever the window. `held` is what `GET /v1/emails?held=true` lists.
- **`domain_days`** returns the domain rollup's rows: delivery-time quantiles over the 7 days before each run and sends by UTC hour of day over the 28 days before, one row per domain per UTC day, live mail only.

## Suspending an organization

A suspended organization can't send. `POST /v1/emails` and `POST /v1/batches` return `403 organization_suspended`, with `detail.source`, `detail.reason` and `detail.suspended_at`. Reads keep working.

`source` is `manual` (an admin), `reputation` (the org-level pause) or `provider` (the provider paused the organization behind it). New sends are refused under every source. What's already queued depends on it:

- `reputation` and `provider`: it waits, the same as a paused domain, and sends once released. `GET /v1/emails/:id` reports each of those messages with `stall.kind: "organization"`, and `stall.reason: "provider_paused"` under `provider`. Held mail doesn't expire.
- `manual`: each queued message fails with `Organization is suspended: <reason>` and spends no attempt.

An admin can release any suspension. A `provider` suspension also lifts on its own when the provider resumes sending.

The org-level pause runs the domain pause's evaluation over the organization's domains summed, leaving out any domain the domain pause already holds or would hold on its own numbers. It catches an organization spread across domains that each stay under the volume floor. It pushes an admin alert when it fires and clears only by an admin.

When two or more organizations send through one provider identity, their summed rate is checked against the same thresholds. Crossing them pushes an admin alert naming the organizations, once a week per identity and reason. Nothing is suspended.

## Moving a domain to another provider

A domain sends through one provider, `provider_id`, set at creation and returned on every domain response. Moving a domain is staged, not immediate: `PATCH /v1/domains/:id` with a new `provider_id` records a pending binding and creates the domain at the target provider, but doesn't touch what the domain sends through. The domain keeps sending on its current provider for as long as the move is pending.

The response's `pending` field carries `provider_id`, `dns_records` and `missing_records` for the target provider, and `started_at`. It's `null` when no move is in progress. Publish the pending records alongside the ones already live; the two providers' records can coexist on the domain's DNS throughout the move.

The move cuts over on its own, in the background, once the pending binding verifies with nothing missing: `provider_id` swaps to the target, its records become `dns_records`, and `pending` goes back to `null`. Nothing else changes — a key scoped to the domain, and every message already sent, are unaffected.

`PATCH /v1/domains/:id` with `provider_id: null` cancels a move in progress, at no cost: the domain created at the target is dropped and the domain's current binding is untouched. A pending binding that never verifies expires on its own after two weeks.

A target provider has to support what a move needs — creating a domain and answering verification through its API — the same as adding a domain does. A provider that can't returns `capability_unavailable`.

`dns_records` is the complete list: DKIM for the domain, plus whatever else the provider needs. Publish what it lists and nothing else.

Where the provider puts SPF and an MX on a `mail.` subdomain, as SES does, that subdomain is the envelope sender it bounces to. SPF is checked against that subdomain, not the domain in `from`, so a domain publishing `v=spf1 -all` at its apex to declare that the bare name sends no mail keeps that record unchanged — DKIM aligns strictly, and the `mail.` subdomain aligns with the apex under relaxed alignment, so DMARC passes either way.

A record carrying `merge: "spf"` sits at a name the domain may already use for SPF, as Mailpace's apex record does. A name can have exactly one SPF record: a second resolves to `permerror`, which fails SPF for all of that domain's mail, not only what's sent through here. Publish the value as it stands when the name has no SPF record, and otherwise add its mechanisms to the record already there. Each `include:` costs one of the 10 DNS lookups SPF allows.

Every record carries `required`: `true` for a record the domain can't verify without, `false` for one that improves deliverability or routing but doesn't gate verification — SES's DKIM CNAMEs versus its MAIL FROM MX and TXT, for example. An optional record in `missing_records` isn't a blocked setup; only a required one is.

## Providers

A provider is one set of credentials for a provider adapter, such as an SES account or a Mailpace organization. Admins create and manage every provider and assign each organization one. Domains bind to an assigned provider. An organization key reads its providers and never writes them.

| Route | Does |
|---|---|
| `GET /v1/providers` | Lists the organization's providers, newest first, with `limit` and `cursor`. |
| `GET /v1/providers/:id` | One provider. |
| `POST`, `PATCH`, `DELETE` | `405 method_not_allowed` with `Allow: GET, HEAD, OPTIONS`. |

Both routes need a key with no domain scope; a scoped key returns `403`. There's no test route: `POST /v1/providers/:id/test` answers `404`.

A response carries `id`, `adapter`, `name`, `assigned`, `status`, `backoff_until`, `created_at` and `updated_at`. It never carries credentials or settings; settings hold provider ARNs that name the admin's AWS account.

- `assigned` is `true` for the organization's assigned provider, which a new domain binds to by default.
- `status` is `ready`, `setting_up`, `paused` or `unavailable`, with no provider text. A provider with no domains yet reads `ready`. `setting_up` means the first domain's setup at the provider hasn't finished.
- `adapter` stays because capabilities follow it: bulk, custom headers and inbound.

## Suppressions

A suppression blocks every send to an address, on every domain in the organization. It's checked when a message is accepted and again just before it's sent, so mail held in the queue fails instead of going to an address suppressed since. A hard bounce or complaint adds one on its own; these routes bring a list from somewhere else, read it back and take an address off it. All four need a key with no domain scope, since the list spans every domain; a scoped key returns `403 key_not_scoped`.

| Route | Does |
|---|---|
| `POST /v1/suppressions` | Takes `suppressions`, an array of `{ address, reason, detail }`, plus a default `reason` (`manual` when omitted) and `source`, a label for where the list came from (`api` when omitted). Returns `200` with `added`, `already_present`, `invalid` and `errors`. |
| `GET /v1/suppressions` | Lists the organization's suppressions, newest first, with `limit`, `cursor`, `reason`, `address`, `domain`, `since` and `until`. `domain` is the domain id of the message that caused it. |
| `GET /v1/suppressions/:address` | One suppression. The segment is its id or the address, URL-encoded. |
| `DELETE /v1/suppressions/:address` | Takes one address off the list, matched on its normalized form. Sends to it go out again. Returns `200` with `address` and `removed`. An address that isn't on the list is a `404`. URL-encode the address. |

- **At most 5,000 rows per call.** More is a `422 validation_failed` and nothing is written. Split a larger list across calls; a repeated row costs nothing.
- **An existing suppression wins.** An address already on the list keeps its row, reason and history, and counts as `already_present`. So does a repeat of an address earlier in the same request. Nothing is updated. To change a reason, `DELETE` the address and import it again.
- **Addresses are normalized the way a send is**: the domain part lowercased, the local part kept.
- **A bad row is reported, not fatal.** Each invalid row is an entry in `errors` with `line`, `address` and `message`, and the rest still import. The valid rows commit together.
- **CSV works too.** A `text/csv` body takes an `address` (or `email`) column and optional `reason`, `detail` and `source` columns, with the default `reason` and `source` in the query string. `line` then names the file's line. A reason cell reading `HardBounce`, `SpamComplaint`, `bounce` or similar maps to ours; any other text becomes the row's `detail` and the row takes the default reason. The dashboard's export writes this header, so an export imports unchanged.
- **Unsubscribes aren't suppressions.** A suppression stops transactional mail too. Import a provider's unsubscribe list into a list instead (`POST /v1/lists/:id/members`), unless the person asked for no mail at all.

A suppression response carries `id`, `address`, `reason`, `detail`, `bounce_type`, `source`, `source_message_id` and `created_at`. `detail` is the provider's text verbatim, such as an SMTP diagnostic. `bounce_type` is the provider's classification, such as `Permanent/NoEmail`, stored from the bounce onward; rows from before it was stored carry it only where the bounce event survives. For the address's send history, list `GET /v1/emails` with `to`. An import that adds at least one row records one `suppression.imported` activity row with the counts.

A list import (`POST /v1/lists/:id/members` with `members` or a CSV body) returns `imported`, every membership the request names whether new or not, plus `added`, `already_present`, `invalid` and `errors`. One that adds at least one member records one `list.members.imported` activity row with the counts and no addresses.

## Recipients

`GET /v1/recipients/:address` reads what the organization has on one address, the same record the dashboard shows. URL-encode the address; it's matched on its normalized form, the way a send is. It needs a live key with no domain scope, since the record spans every domain and holds live mail; any other key returns `403 key_not_scoped`. An address with no message, suppression or unsubscribe on file is a `404`.

- `messages` counts messages addressed to it by status, test mode included: `total`, `delivered`, `bounced`, `complained` and `failed`. The rest are in flight. Page through them with `GET /v1/emails` and `to`.
- `bounce_count`, `complaint_count` and the `last_*_at` timestamps count provider events naming the address. A message to several addresses bounces for one of them, so these can differ from `messages`.
- `suppression` is the suppression response plus `added_by` and `source_message`, or `null`.
- `unsubscribes` holds `lists`, each `{ list_id, unsubscribed_at }`, and `domains`, each `{ domain_id, unsubscribed_at }`.
- `include=history` adds `history`, the latest 50 messages, and `incidents`, the latest 50 that bounced or complained. Each item is `{ id, subject, domain_id, status, test_mode, created_at }`.

There's no list of every recipient. It's computed from every message the organization holds, so it stays on the dashboard.

## Exports

The dashboard's own export buttons (message log, bodies, suppressions and domain config) stream a file directly for anything under a size ceiling. `/v1/exports` is the automatable path `docs/leaving.md` describes: request one, poll it, download it once it's ready.

| Route | Does |
|---|---|
| `POST /v1/exports` | Takes `kind` and, for a filtered kind, the same `status`, `domain`, `tag`, `since` and `until` filters `GET /v1/emails` takes. Always creates a queued export and returns `202`, whatever the row count — there's no synchronous response here, since a caller is already polling either way. |
| `GET /v1/exports` | Lists the organization's exports, newest first, with `limit` and `cursor`. |
| `GET /v1/exports/:id` | One export's current status. |

In every CSV export, a text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`, so a spreadsheet doesn't run it as a formula. Pouch's own CSV imports remove it.

`kind` is `log_csv`, `log_ndjson`, `bodies` or `data`. The first three take the message filters above and are scoped to the key's domains, the same as `GET /v1/emails`; `data` (suppressions and domain configuration) is whole-organization and needs a key with no domain scope, the same rule `POST /v1/domains` enforces, since a domain-scoped key couldn't otherwise be handed every domain's DNS records.

A domain-scoped key reads back only exports held to domains inside its scope. One made from the dashboard, one with no domain limit and every `data` export read as `404` to it.

`status` moves `requested → running → ready` or `requested → running → failed`. Poll `GET /v1/exports/:id` until it's one of those two — or `expired`, if nobody polled for a week. `download_url` is a signed link into private storage, present only while `status` is `ready`; it's minted fresh on every read rather than stored, so read the export again for a current one rather than caching the first you saw. A `bodies` export still marks a body that's aged out of retention with why, never blank — see `docs/product/brief.md`, "The record is yours."

**The artifact's lifetime is short and fixed, not tied to the organization's body retention setting.** An export is a second, unencrypted copy of whatever the dashboard would otherwise have streamed straight to a browser — for `bodies`, that's decrypted message content a second time over. It's deleted 7 days after `ready_at` regardless of how long the organization otherwise keeps bodies; `status` reads `expired` afterward and the export has to be requested again. Nothing above the size ceiling is refused: past it, the request that used to return `422 export_too_large` now queues instead.

## Activity

Every organization has an activity log: who changed provider configuration, and when. A route records when it changes something that outlives the request — adding, moving or deleting a domain; suppressing, importing or unsuppressing addresses. Provider-provider writes are admin-only and record on both the service and the organization they touch (`docs/api/admin.md`). A route that only reads, or that does the service's ordinary work of accepting a message, doesn't — a send is already recorded far better by the message log itself, and logging every one here would drown the thing this log exists for. `POST .../test` and other read-only checks don't record either: nothing changed.

`GET /v1/activity` reads the log newest first, with `limit` and `cursor`, and `GET /v1/activity/:id` reads one entry. Both need a key with no domain scope: the log spans every domain. An entry carries `id`, `action`, `family`, `outcome`, `actor` (`{ type, id, label }`), `applies_to`, `subject_label`, `address`, `metadata` and `created_at`. `metadata` is what changed for that action, keys in snake_case. A list member's or suppression's address appears only while its row exists (`docs/decisions.md`, "Activity names a list member by id, never by address").

An API key shows up in the log the same as a dashboard session, as `actor.type: "api_key"`. A service admin working inside an organization they don't belong to shows up as `actor.type: "admin"`, never as a member — see `docs/decisions.md`, "An admin emulates an organization deliberately, and it expires". The write is best-effort: if it fails, the request that triggered it still succeeds.

## Provider events

Providers post delivery events to `/api/webhooks/:adapter/:provider_id`. The path names the provider, so the receiver knows the organization and the credentials without scanning. Every event is signature-checked against that provider's key before it's read: SES over the SNS envelope, Mailpace over the raw body with Ed25519. An unsigned or forged event returns `401` with `code: "invalid_signature"` and is logged. The `mock` adapter refuses every call the same way; test mode applies its events inside the worker. A retried event applies once. An event for a message the service doesn't have is accepted and ignored, so the provider stops retrying.

## Fan-out detection

`POST /v1/emails` sends one body per request; nothing stops a caller from sending the same body to thousands of addresses across separate requests. Real transactional mail varies per recipient — a password reset, a receipt, an invitation — so Pouch hashes the rendered body (the html after layout wrapping, plus the text part) on every send and counts distinct recipients on that hash, per key, per UTC day.

Below `BULK_FANOUT_THRESHOLD` (200 by default, set via the environment variable of the same name) nothing changes. Past it, the request needs a `List-Unsubscribe` header or it's rejected with `422 list_unsubscribe_required` naming the count and the threshold; adding the header clears it immediately, on the same request. This is the line Gmail and Yahoo already draw for bulk senders — Pouch enforces it once a key crosses it, rather than assuming every sender already complies.

A genuine transactional message that happens to be identical for many recipients — a service outage notice, a terms update — trips this the same as a real blast, and that's by design: the fix costs one header, not a rewrite. Only a key's own live sends count; test-mode sends never reach a real recipient and are excluded. There's no admin override for a hash that's a known-legitimate false positive — clearing the hold always means adding the header, even when a human has already looked at it and confirmed it's fine.

The header only clears the hold when the domain's provider will actually carry it. A header the provider drops in transit isn't compliance, it's the appearance of it, so a domain whose provider can't carry custom headers at all — Mailpace — returns `422 bulk_not_allowed` instead of accepting the header and silently sending without it. This isn't only a technical limit: Mailpace's own terms are transactional-only, so an identical body reaching 200 recipients through it is a terms violation as much as a deliverability one. The fix there is moving the domain to a provider that can carry the header, not adding one that won't reach the wire.

`list-unsubscribe` and `list-unsubscribe-post` are ordinary headers a caller can set on `POST /v1/emails` today, unchanged by bulk mode. `POST /v1/batches` (#7) generates and signs both itself — one-click unsubscribe has to be a link Pouch signs, not one the caller supplies — and accepts no `headers` field at all, so there's nothing to reserve there.

## Bulk (#7, #246)

`POST /v1/batches` takes `from`, `subject`, `html`, `text`, `layout`, `tags` and either `list` (a list id) or `recipients` (an array of `{ address, attributes }`). `attributes` is a flat map of strings, substituted into `{{name}}` placeholders in `subject`, `html` and `text`. Each recipient becomes one message with `batch_id` set. Unsubscribed and not-yet-confirmed addresses are skipped and counted. Every bulk message carries `List-Unsubscribe` and `List-Unsubscribe-Post` headers, generated and signed by the service — a batch send accepts no `headers` field.

A domain sends bulk only when both are true: an admin turned `bulk_allowed` on for it (`PATCH /v1/domains/:id`), and the domain's provider adapter declares `capabilities.bulk`. Every domain starts with `bulk_allowed: false` — there's no migration that guesses which existing domains meant to allow it. A refused batch returns `422 bulk_not_allowed` with `detail.reason`: `provider_incapable` when the provider can't do bulk at all (fix: move the domain), or `domain_disabled` when the admin hasn't turned it on (fix: flip the switch on the domain screen). Turning `bulk_allowed` on for a domain whose provider can't do bulk is refused the same way, at the point of turning it on rather than at the next send. So is a domain with no valid DMARC record (`dmarc_required`); see "DMARC".

A member's `attributes` are editable with `PATCH /v1/lists/:id/members/:memberId`, which replaces the map outright — a key left out is gone. Nothing else on a membership changes: a different address is a different member, and consent moves through the confirm and unsubscribe doors instead.

`GET /v1/batches/:id` returns the batch plus `counts`, a tally of its messages by lifecycle status.

## Unsubscribe (#7)

Three doors:

- Each bulk message carries `List-Unsubscribe: <https://…/u/<token>>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. The token is signed and scoped to one address and one list (or, for a batch sent to inline `recipients` with no list, to one address and the domain); the address never appears in the URL — the token signs an opaque row id instead. `GET` on it renders a page that asks, with a button to unsubscribe from the list and one to stop all bulk mail from the domain; `GET` changes nothing, so a link scanner unsubscribes nobody. The page's buttons post a `scope`. A `POST` without one, RFC 8058's one-click, unsubscribes from the list and returns `200` with no body.
- `POST /v1/lists/:id/unsubscribe` with `{ address }`, key-authenticated.
- `POST /v1/domains/:id/unsubscribe` with `{ address }` for all lists on the domain.

**Branded unsubscribe page.** A domain can set `unsubscribe_url`. When set, the footer link points at `<unsubscribe_url>?token=<token>` instead of the hosted page. The page redeems the token with `POST /v1/unsubscribe` and body `{ token, scope: "list" | "domain" }`, no key, CORS-open, callable from the browser. The response carries the list name and the domain so the page can say what happened. `List-Unsubscribe-Post` keeps pointing at the hosted URL, since mail clients POST there without a page.

Every unsubscribe emits `email.unsubscribed` to the caller's webhook. Unsubscribes are tracked separately from suppressions — a list membership's own `status: "unsubscribed"`, or a row in `domain_unsubscribes` for the "stop all bulk mail" case.

**An unsubscribe blocks bulk; a suppression blocks everything.** Unsubscribing withdraws consent from a list, so it stops batch sends and leaves `POST /v1/emails` alone — a marketing opt-out never silently breaks a password reset. Suppression is the safety list (hard bounce, spam complaint) and blocks every send, transactional included. The dashboard shows which one applied.

## Double opt-in (#7)

`PATCH /v1/lists/:id` changes a list's `name` and `double_opt_in`. The opt-in mode governs adds from that point on: every membership stores the mode it was added under, so turning it off doesn't confirm anyone already pending, and turning it on doesn't unconfirm anyone.

Lists have `double_opt_in`, default `true`. With it on, a membership from `subscribe` on a send, from `POST /v1/lists/:id/members`, or from the recipients view enters `status: "pending"` and Pouch sends a confirmation from the domain with a signed link. Confirming on the hosted page it opens (a `GET` only asks, so a link scanner confirms nothing), or redeeming the token through `POST /v1/confirm { token }` from a page at the domain's `confirm_url`, sets `status: "subscribed"` and `confirmed_at`. Pending memberships expire after 7 days and never receive a batch. Imports may pass `confirmed: true`; the membership then records `confirmed_by: "import"`. Every membership records the opt-in mode that applied (`confirmed_by`: `link`, `import` or `not_required` when the list has double opt-in off). Confirmation emits `list.subscribed`.

## Idempotency

`Idempotency-Key` header on `POST /v1/emails` and `POST /v1/emails/:id/resend`. On a resend, the request is the original's id, so a repeat for another message conflicts. A repeat within 24 hours returns the original response with the same id. A repeat with a different body returns `409`, and so does a repeat of a key older than the window, since a key stays bound to the message it created. `detail` carries the original `message_id` and `window_expired`, which tells the two apart. A key can only be replayed by a key scoped to the original message's domain.

## Errors

Every `/v1` response, success or error, carries `X-Request-Id`. Send your own with an inbound `X-Request-Id` header to correlate our logs with yours; it's honored when it's 1-128 characters of letters, digits, `.`, `_` or `-`, and a fresh id is minted otherwise. Log the id on success too — it's the one thing to quote if that message misbehaves later. A send keeps its request id on the message, so quoting it is enough to find every log line about that message, accept through delivery.

Every non-2xx response is:

```json
{
  "error": {
    "code": "domain_not_verified",
    "message": "Domain example.com isn't verified. Add the listed DNS records and verify.",
    "field": "from",
    "detail": {},
    "request_id": "req_8f2c1a9b3d4e5f60718293a4b5c6d7e8"
  }
}
```

- `code` is a stable `snake_case` identifier. Callers branch on it. It never changes meaning.
- `message` is one sentence per the voice doc. It can change.
- `field` names the offending request field when there is one.
- `detail` carries structured context: the suppression reason, the provider's raw error, the DNS records still missing.
- `request_id` matches the `X-Request-Id` response header. Quote it when reporting a problem.

Status codes: `400` malformed JSON, `401` missing or invalid key, `403` key not scoped to the domain, organization suspended or feature turned off, `404` unknown id or unmatched path, `405` unsupported method with `Allow`, `409` idempotency conflict, `422` validation or suppression, `429` rate limit with `Retry-After`, `503` provider unavailable after retries.

Provider limits surface as `422` with `code: "provider_limit"` and the limit in `detail`. The caller learns the domain's provider allows 50 recipients without learning which provider it is.

### Codes

Every code the API returns. A new code lands here in the PR that introduces it.

| Code | Status | When |
|---|---|---|
| `invalid_json` | 400 | The request body isn't parseable JSON. |
| `invalid_key` | 401 | The `Authorization` header is missing, malformed, unknown or revoked, or it's an admin key whose creator is no longer an admin. |
| `invalid_signature` | 401 | A provider callback isn't signed with the key on file for the provider. |
| `key_not_scoped` | 403 | The key is valid but isn't scoped to the domain in `from`, or to the message being read, or it's limited to domains on a route that acts on the whole organization, or it's a test key on a route that holds only live data. |
| `admin_key_required` | 403 | The route is under `/v1/admin` and the key doesn't have the admin scope. |
| `organization_key_required` | 403 | The route acts on an organization and the key is an admin key, which belongs to none. |
| `admin_scope_not_allowed` | 403 | An admin key can only be created by an admin, with no organization, live and with no domain limits. |
| `insufficient_role` | 403 | The caller's role in the organization doesn't allow this — today, owner-only work. Returned by the dashboard's own routes and server actions, never under `/v1`, which authenticates with a key and knows no role. |
| `organization_suspended` | 403 | The organization is suspended and can't send. `detail` carries `source`, `reason` and `suspended_at`. |
| `feature_disabled` | 403 | The install turned off the feature the route belongs to, and the message says where: its environment variable, `pouch.yml` or the Admin settings tab that holds it. Also when a field names one: `subscribe` on a send or `list` on a batch while lists are off. `detail.feature` names it. |
| `not_found` | 404 | No resource with that id in the key's organization, or no route at that path. |
| `invalid_token` | 404 | A confirm or unsubscribe token is malformed, forged or has expired. |
| `method_not_allowed` | 405 | The route exists but doesn't serve this method. `Allow` lists the ones it does. |
| `idempotency_conflict` | 409 | The `Idempotency-Key` was already used with a different body, or is older than the 24-hour window. `detail` carries `message_id` and `window_expired`. |
| `validation_failed` | 422 | A field is missing or its value is the wrong shape. `field` names it. |
| `recipient_suppressed` | 422 | A recipient is on the suppression list. `detail` carries the address and reason. |
| `domain_not_verified` | 422 | The `from` domain isn't verified. `detail` carries the DNS records still missing, or `{ exists: false }` when the domain hasn't been added to the organization at all. |
| `domain_in_use` | 422 | The domain has messages, batches or lists and can't be deleted. `detail.lists` carries the list names when lists are what block it. |
| `reserved_header` | 422 | `headers` contains a header the service sets itself. |
| `list_unsubscribe_required` | 422 | This body has crossed the key's daily fan-out threshold and carries no `List-Unsubscribe` header. `detail` carries the recipient count and the threshold. |
| `bulk_not_allowed` | 422 | Bulk isn't allowed for this domain. `detail.reason` is `provider_incapable` (the provider can't carry what bulk needs — `List-Unsubscribe` past the fan-out threshold on `POST /v1/emails`, or bulk at all) or `domain_disabled` (the admin hasn't turned `bulk_allowed` on for this domain). Also returned from `PATCH /v1/domains/:id` when turning `bulk_allowed` on for a provider-incapable domain, or, with `detail.reason` `dmarc_required`, for a domain with no valid DMARC record. |
| `attachment_too_large` | 422 | Attachments, the message or the request body itself exceed a size limit. A message's body and decoded attachments together can't pass the install's `max_message_mb`, 30 MB unless an admin lowered it, and the provider's own attachment limit applies under it. `detail` carries the limit. |
| `provider_limit` | 422 | The domain's provider can't do what the request asks. `detail` carries the limit, or the capability and what the request asked for. |
| `domain_exists` | 422 | The organization already has this domain. |
| `domain_unavailable` | 422 | The provider already holds this domain for someone else. |
| `domain_not_at_provider` | 422 | `POST /v1/admin/domains` was asked to adopt a domain the provider doesn't have. Add it with `POST /v1/domains` instead. |
| `capability_unavailable` | 422 | The provider can't do this through its API. `detail` carries the steps left to the provider's dashboard. |
| `provider_exists` | 422 | A provider with this name already exists in the organization, or, for a shared provider, among shared providers. |
| `provider_in_use` | 422 | The provider has domains bound to it and can't be deleted. `detail` carries their names. |
| `organization_in_use` | 422 | The organization has mail waiting to send, or holds the domain the service sends its own mail from, so it can't be deleted. `detail.reason` is `mail_in_flight` or `system_mail`. |
| `provider_unassigned` | 422 | The organization has no assigned provider, so a new domain has nothing to send through. An admin assigns one. |
| `credentials_rejected` | 422 | New credentials failed the provider's own live check and weren't stored. |
| `inbound_disabled` | 422 | The domain doesn't accept mail, so an address on it would receive nothing. Enable inbound first. |
| `address_exists` | 422 | The domain already has an address with this local part, live or revoked. |
| `address_limit_reached` | 422 | The organization holds as many active addresses as its limit allows. `detail.limit` carries it. |
| `address_inactive` | 422 | The address is expired or revoked, so it can't send or forward. `detail.status` says which. |
| `reply_not_allowed` | 422 | The reply would fail DMARC or answer a forged sender. `detail.reason` is `sender_unverified` (the message failed DMARC), `provider_incapable` (the domain's provider can't send from its inbound host) or `strict_alignment` (the DMARC policy sets `adkim=s`). |
| `forward_not_allowed` | 422 | A forward from this address would fail DMARC. `detail.reason` is `provider_incapable` or `strict_alignment`, as for a reply. |
| `forward_target_exists` | 422 | The address already forwards to this mailbox, or is waiting on it to confirm. |
| `forward_target_limit_reached` | 422 | The address holds 5 targets, or the organization 20 unconfirmed ones. `detail.scope` is `address` or `pending`, `detail.limit` the number. |
| `forward_target_not_pending` | 422 | The target is confirmed or disabled, so there's no confirmation to resend. `detail.status` says which. |
| `resend_not_allowed` | 422 | The original can't be resent. `detail.reason` is `withheld`, `shredded` or `expired` when its body can't be read, or `unsubscribed` when a bulk original's recipient has unsubscribed from its domain since. `detail.ended_at` is when the body stopped being readable, or null. |
| `rate_limit_exceeded` | 429 | The key's per-minute limit is spent. `Retry-After` says when to try again. |
| `stream_limit_exceeded` | 429 | This key already has the maximum number of streams open. Close one and reconnect. |
| `provider_unavailable` | 503 | The service can't complete the request. |
| `storage_unavailable` | 503 | Object storage didn't answer, so the original's body couldn't be read for a resend. Retry the request. |

## Pagination

List endpoints take `limit` (default 50, max 200) and `cursor`. Responses carry `data` and `next_cursor`, null on the last page. Newest first.

## Include and fields

Every GET route that returns a resource or a page of them takes `fields`. Routes with expansions also take `include`. Both are comma-separated lists.

- `include` adds expansions: parts of a response that are heavy or loaded on their own, such as `include=body,events`.
- `fields` returns only the top-level keys it names, in place of the defaults. The item's id always comes back: `id` everywhere, `user_id` on an organization's members, `provider_id` on a provider's assignments and `window` on stats. It applies to a list's items and to a single read alike. Naming any key of an expansion returns the whole expansion.
- Together, `fields` picks the base and `include` adds to it: `fields=status&include=body` returns `id`, `status`, `body` and `body_unavailable`.
- An unknown name is a `422 validation_failed`, with `field` set to `include` or `fields` and `detail.unknown` and `detail.valid` listing the names. A route without expansions has no `include`, and ignores it like any other parameter it doesn't take.
- Without either, a response is what it's always been. An expansion that's in a route's default stays there; leave it out of a `fields` list to skip loading it.
- There's no `include=all`. Name what you need.
- MCP tools and the SDK take both as arrays of the same names.

| Route | Expansions | In the default |
|---|---|---|
| `GET /v1/emails` | `events`, `occurrences`, `body`, `rendered`, `resends` | none |
| `GET /v1/emails/:id` | `events`, `occurrences`, `stall`, `body`, `rendered`, `resends` | `events`, `stall`, `resends` |
| `GET /v1/inbound`, `GET /v1/inbound/:id` | `body` (`text` and `html`), `delivery` | `body` |
| `GET /v1/addresses/:id/messages` | `body` (`text` and `html`) | `body` |
| `GET /v1/domains` | `standing` (`standing` and `standing_reason`) | `standing` |
| `GET /v1/domains/:id` | `standing`, `reputation`, `dmarc` | `standing` |
| `GET /v1/domains/:id/dmarc_reports` | `records` | none |
| `GET /v1/providers`, `GET /v1/providers/:id` | `status` | `status` |
| `GET /v1/lists`, `GET /v1/lists/:id` | `member_counts` | neither |
| `GET /v1/organization` | `address_counts` | neither |
| `GET /v1/batches/:id` | `counts` | `counts` |
| `GET /v1/recipients/:address` | `history` (`history` and `incidents`) | neither |
| `GET /v1/webhook_endpoints/:id/deliveries` | `payload`, `attempts` | neither |
| `GET /v1/webhook_endpoints/:id/deliveries/:deliveryId` | `payload`, `attempts` | both |
| `GET /v1/stats` | `previous_buckets`, `latency`, `domains`, `keys`, `reasons`, `queue`, `inbound`, `domain_days` | none |
| `GET /v1/admin/providers`, `GET /v1/admin/providers/:id` | `health` (`status`, `issues` and `health`) | `health` |
| `GET /v1/admin/organizations`, `GET /v1/admin/organizations/:id` | `counts` (`assignment_count` and `domain_count`) | `counts` |
| `GET /v1/admin/users`, `GET /v1/admin/users/:id` | `memberships` | `memberships` |

Every other resource read takes `fields` alone: keys, webhook endpoints, activity, suppressions, list members, addresses, forward targets, exports and an organization's members and invitations. `GET /v1/admin/providers?status=attention` reads health to filter, whatever the response returns.

`member_counts` is `{ pending, subscribed, unsubscribed }`, counted on read.

`address_counts` is `{ active, expired, revoked }`, counted on read. `active` is what `address_limit` caps.

`delivery` on an inbound message is the newest delivery to its domain's webhook, in the shape the delivery log returns without `payload`, or `null` when none was queued.

`body` on a sent message is `{ html, text, attachments }`. `html` is as accepted, before the domain's layout wraps it. Each attachment carries `filename`, `content_type`, `size` and a `download_url` valid for 15 minutes, minted on every read. When the body can't be read, `body` is `null` and `body_unavailable` says why: `{ reason, message, ended_at }`, where `reason` is `withheld` (the message is sensitive, and its body is never returned), `shredded`, `expired` or `unavailable` (storage didn't answer; read again). One of the two is always null.

`rendered` is `{ html, framed, frame_changed }`: the html part as the recipient got it, wrapped in the domain's layout and the send's overrides when it asked for them. It's rendered on read from the domain's current layout, so `frame_changed` is `true` when the layout or its template changed after the message was accepted and the frame isn't the one sent, and `null` when the message predates the hash that tells. The text part is never framed; it's `body.text`. Like `body`, it's `null` when the body can't be read, and `body_unavailable` comes with either. Naming `body_unavailable` in `fields` returns both expansions.

`occurrences` lists what happened to a message without changing its status, oldest first in the same order as `events`: `{ id, kind, reason, occurred_at, detail }`. `kind` and its `detail`:

| `kind` | `detail` |
|---|---|
| `retry` | `{ attempt, next_attempt_at }`: a send the provider refused for now. `reason` is its answer. |
| `backoff` | `{ until, count }`: the provider asked for a pause. Repeats fold into one row, counted. |
| `suppressed` | `{ address, suppression_reason }`: this message's bounce or complaint suppressed the address. |
| `body_shredded` | `{ retention_days }`: the body's key was destroyed past retention. |
| `webhook_delivered` | `{ event_type, host, status_code }`: an event about this message reached an endpoint. The host only: a URL's path and query can carry a secret. |
| `abandoned` | `{}`: the same moment as `abandoned_at`. |

Neither parameter applies to the event streams (`GET /v1/emails/:id/events`, `GET /v1/events`), a list's CSV export, `GET /v1/reputation`, `GET /v1/domains/:id/inbound` or a conversion plan. A webhook payload, a stream frame and a send response carry the message's base shape.

Each route's shape is declared once: messages in `lib/schemas/message.ts`, inbound mail in `lib/schemas/inbound.ts`, the rest in `lib/schemas/shapes.ts`. `lib/api-docs/shapes.ts` maps every GET route to its shape or records why it has none, and the parsing, the errors, the reference and the MCP tool arguments come from there (`lib/api/shape.ts`).

## Filtering

`GET /v1/domains` takes `status`. `GET /v1/keys` takes `mode`, `revoked` and `domain`, the one filter that isn't exact-match: it also lists keys limited to no domain. `GET /v1/webhook_endpoints` takes `key_id`. `GET /v1/suppressions` takes `reason`, `address`, the address matched on its normalized form, `domain` and `since` / `until`. `GET /v1/emails` takes `status` (one or several, comma-separated), `domain` (a domain id), `key` (a key id), `batch` (a batch id), `held`, `sensitive`, `tag`, `to`, `reason` (a bounce or complaint reason), and `since` / `until` on `created_at`, as ISO 8601 timestamps. `POST /v1/exports` takes `status` (one), `domain`, `tag`, `since` and `until`, for a filtered kind. `GET /v1/inbound` takes `domain` and `outbound_message`, the id of the sent message the mail replies to. `GET /v1/activity` takes `family` and `outcome`, each one or several comma-separated, `actor`, comma-separated `type:id` pairs (`type:label` for the worker, which has no id), and `since`. The rest are exact-match. No free-text search in the API.

## Outbound webhooks

- Registered per key, through `/v1/webhook_endpoints` or the dashboard's key detail page. One URL and an event allow-list per endpoint.
- Events a key-scoped endpoint can subscribe to: `email.delivered`, `email.bounced`, `email.complained`, `email.unsubscribed`, `list.subscribed`, `address.received`, `domain.reputation_changed`, `organization.reputation_changed`. `inbound.received` is the one event a domain-scoped endpoint (`domain_id` set, one per domain, registered through `PATCH /v1/domains/:id/inbound`) ever carries — it's never in a key-scoped endpoint's own allow-list. `email.unsubscribed` and `list.subscribed` have no single message behind them — a key-scoped endpoint gets one when its key's scope reaches the domain the event happened on, the same domain-scoping rule as everywhere else.
- Body is `{ id, type, created_at, data }`. `data` is the message shape `GET /v1/emails/:id` returns, except on the reputation events below.
- `domain.reputation_changed` and `organization.reputation_changed` fire when a standing changes between `healthy`, `watch`, `at_risk` and `paused`. `data` is `{ object: "reputation", subject: { type, id, name }, standing, previous_standing, changed_at, findings }`, and each finding is `{ kind, standing, title, body, action }`. A domain event follows the domain-scoping rule above. An organization event reaches only keys scoped to every domain, since it summarizes all of them. The worker checks standing every few minutes, so an event can trail the numbers by that much.
- Signed with HMAC-SHA256, keyed by the endpoint's secret, over `<timestamp>.<raw body>` — the exact string a receiver reconstructs by joining `X-Timestamp` and the raw request body with a dot. The signature is in `X-Signature` as `sha256=<hex>`. The timestamp is inside the signed material deliberately: outside it, it's attacker-mutable and buys the replay check nothing. Reject anything where `X-Timestamp` is more than five minutes old.
- `X-Webhook-Id` carries the delivery id and `X-Webhook-Event` the event type, so a receiver can dedupe a retried delivery — a retry sends the identical id, event and body as the first attempt.
- Retried on any non-2xx response or transport error, with backoff: 30s, 2m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, then every 6h until 24 hours from the first attempt, then the delivery is marked exhausted. A `410` response stops retrying immediately. An endpoint with enough consecutive exhausted deliveries disables itself.
- Every attempt is logged: status, response code, duration and the payload sent. Read them on the key's page in the dashboard or at `GET /v1/webhook_endpoints/:id/deliveries`.
- A host that stops resolving is a transport failure and retries on the schedule above. Only a URL the service refuses to call at all — one resolving to a private address, plain `http` or malformed — is exhausted without retrying.
- Endpoints belong to a key, so only a send made with that key produces events for it. A message sent from the dashboard carries no key and reaches no endpoint; use "Send test event" on the endpoint itself to exercise a receiver.
- Revoking a key stops its endpoints at once: nothing new is queued for them, and what was already queued is dropped.
- Delivery is at-least-once. An event is enqueued after the transaction that recorded it commits, and a delivery whose bookkeeping write fails is retried, so the same `X-Webhook-Id` can arrive twice. Dedupe on it.

## Inbound (#6)

- A domain accepts mail once inbound is enabled on it, which requires a webhook URL: `PATCH /v1/domains/:id/inbound` with `{ enabled: true, webhook_url }`. The response's `webhook_secret` is shown once, the same as a key-scoped endpoint's secret. Enabling adds the provider's own inbound records — an MX or CNAME, depending on the provider — to the domain's `dns_records`, on a subdomain so the domain's own mailbox is untouched. The subdomain is `inbound` unless `subdomain` names another label; changing it replaces those records, and `host` reports where mail goes. A subdomain that already holds the domain's sending records, such as SES's `mail.` MAIL FROM, returns `validation_failed`: one host can't carry both MX records.
- On SES, enabling also routes the subdomain at SES itself, so there's nothing to paste into a console and `receiver_url` is null. It returns `capability_unavailable` until an admin gives the provider an inbound bucket and the account an active receipt rule set.
- Disabling is `{ enabled: false }`, which stops new deliveries and leaves the webhook registered. `{ enabled: false, webhook_url: null }` removes the endpoint outright, so `GET /v1/domains/:id/inbound` reports `webhook_url: null` rather than an address nothing posts to. `{ enabled: true, webhook_url: null }` is a `422` — enabling still needs somewhere to deliver.
- One webhook per domain, delivered through the same signed, retried machinery as outbound events above — HMAC-SHA256, `X-Signature`/`X-Timestamp`/`X-Webhook-Id`, the same backoff schedule, the same auto-disable. The one event it ever carries is `event.type: "inbound.received"`, and `data` is the shape `GET /v1/inbound/:id` returns.
- `GET /v1/inbound/:id` returns one message while it's retained. `GET /v1/inbound` lists them, newest first, filterable by `domain` and by `outbound_message`, which returns the replies to one send. Both return `text` and `html` by default; a `fields` list without them skips reading the body (see "Include and fields").
- Content isn't inlined. Each attachment's `download_url`, and the message's `raw_download_url` (the original as `message/rfc822`, when the provider handed it over), is a signed link minted on every read and valid for 15 minutes. A webhook payload carries them as null: read the message for fresh ones. The payload carries `text` and `html` inline; its stored copy, shown in the delivery log and redelivered on retry, loses both when the message is purged.
- `verdicts` carries the provider's spam, virus, SPF, DKIM and DMARC results where it scans (SES), null otherwise. A message that failed the virus scan is quarantined: its attachments read `quarantined: true` with no link, and it has no raw message.
- Retained 7 days by default, per domain (`retention_days` on the same `PATCH`), up to the install's ceiling: 30 unless an admin changed it. Above it is `422 validation_failed` with `detail.max`. A sweep purges the row, its attachments and its raw message together once the window passes, or once the ceiling does when an admin lowered it below the domain's value — see docs/decisions.md. `expires_at` is set on receipt and doesn't move with a later change.
- No folders, no IMAP, no replying from the dashboard. `in_reply_to` is matched against a sent message's `provider_message_id` and surfaced as `outbound_message_id` when it lines up.
- `thread_id` (`thr_`) groups a message with the stored ones it names in `In-Reply-To` or `References`, matched on `Message-ID` within the organization. A reply to mail an address sent joins the thread of the message that mail answered. A reply that arrives before its parent starts a thread of its own.

## Addresses

An address is a local part on a domain's inbound host that code creates, receives on and lets expire. The domain needs inbound enabled.

| Route | Does |
|---|---|
| `POST /v1/addresses` | Takes `domain_id`, `local_part` (random when omitted), `label`, `message_cap` and exactly one of `expires_at` or `expires_in` (seconds, 60 to 365 days). Returns `201`. |
| `GET /v1/addresses` | Lists the organization's addresses on the key's domains, newest first, with `limit`, `cursor`, `domain` and `status`. |
| `GET /v1/addresses/:id` | One address. |
| `PATCH /v1/addresses/:id` | Takes any of `expires_at`, `expires_in`, `label` and `message_cap`. Moving an expired address's expiry forward makes it active again. |
| `DELETE /v1/addresses/:id` | Revokes the address and returns it with `revoked_at` set. |
| `GET /v1/addresses/:id/messages` | The address's mail, newest first, with `limit`, `cursor`, `after`, `thread` and `wait`. Read one message with `GET /v1/inbound/:id`. |
| `POST /v1/addresses/:id/reply` | Takes `message_id`, `html` or `text`, and optional `subject`, `cc`, `attachments` and `tags`. Returns `202` with the queued message, as `POST /v1/emails` does. |
| `POST /v1/addresses/:id/forward_targets` | Takes `email`, mails it a confirmation link and returns `201` with the pending target. |
| `GET /v1/addresses/:id/forward_targets` | The address's targets, oldest first. |
| `GET /v1/addresses/:id/forward_targets/:targetId` | One target. |
| `DELETE /v1/addresses/:id/forward_targets/:targetId` | Removes the target. Forwards still queued for it don't send. |
| `POST /v1/addresses/:id/forward_targets/:targetId/resend_confirmation` | Mails a new link to a pending target. The old link stops working. |

- `status` is `active`, `expired` or `revoked`. Only `revoked` is final, and a revoked address's local part is never reissued.
- Mail to an active address emits `address.received` to the creating key's endpoints that subscribe to it. `data` is the inbound message shape plus `address` and `flags`. The domain's own webhook doesn't hear it.
- After expiry or revocation, mail is dropped silently and counted in `counts.dropped_expired`. Nothing is refused or bounced: the provider already accepted it, and a bounce now goes to a sender who may be forged.
- A message past `message_cap` or the organization's `address_daily_message_limit` (UTC day) is dropped and counted in `counts.dropped_over_limit`. `counts.received_today` is what the address has taken on the current UTC day. Creating past `address_limit` active addresses returns `address_limit_reached`.
- A message that fails the virus scan is never delivered or kept, and counts in `counts.dropped_virus`. Spam and DMARC failures are delivered with `flags` naming them.
- Delivered mail is an inbound message like any other: listed by `GET /v1/inbound`, with `address_ids`, and purged on the domain's retention window.
- The same scope rules as `/v1/emails`: a domain-limited key reaches only its domains' addresses. A test key gets `403 key_not_scoped`.
- An expired or revoked address's mail stays readable until the domain's retention window purges it.

**Waiting.** `wait` (seconds, up to 55) holds the request until a message matches or the time runs out, then returns the page, empty on a timeout. `after` (a message id) narrows to mail newer than one already seen, so a caller waits for the next message rather than getting the last one back. A waiting request holds one of the key's 10 stream slots (`429 stream_limit_exceeded` past them) and can't take `cursor`. Ingest announces new mail on Redis; without Redis, a wait re-reads every second.

**Replying.** A reply sends from the address to the message's `Reply-To`, or its sender, with `In-Reply-To` and `References` set from it and `Re: ` on the subject unless one is given. It goes through the send path, so every rule of `POST /v1/emails` holds: verified domain, key scope, suppression, fan-out, provider limits, `Idempotency-Key`. An address only sends as a reply; `POST /v1/emails` from an inbound host still returns `domain_not_verified`. That's deliberate: an address that could start conversations would be a throwaway sender, which is how relays get abused.

- The address has to be active, or `address_inactive`.
- The message has to have been delivered to this address, or `404`.
- A message that failed DMARC gets no reply (`reply_not_allowed`, `sender_unverified`): its sender may be forged, and the reply would land on them.
- The reply is signed for the domain, not the inbound host. SES gives a subdomain the domain's identity and DKIM key, so DKIM passes with `d=<domain>` and aligns under DMARC's default relaxed alignment; no new record is needed. A policy with `adkim=s` can't pass and returns `strict_alignment`; SPF isn't relied on. Mailpace only sends from the domain a token belongs to, and Cloudflare's subdomain sending is unconfirmed, so both return `provider_incapable`.

**Forwarding.** An address forwards what it admits to its confirmed targets. A forward goes through the send path like a reply, so suppression, provider limits and domain verification apply. A provider or DMARC policy that would refuse a reply refuses a forward target as `forward_not_allowed`.

- A target is `pending` until its mailbox opens the link Pouch mails it from the system from address. Nothing forwards to a pending target. The link expires in 7 days and works once; the page it opens asks before it confirms, so a link scanner can't confirm for anyone.
- A forward comes from the address, named `"<sender name or address> via <address>"`, with Reply-To set to the original sender (its Reply-To, when it had one). The sender's domain is never in From: Pouch can't sign for it, so it would fail the sender's DMARC. A reply from the mailbox goes straight to the sender.
- The forward keeps the original subject, body and attachments, adds a one-line footer naming the address and a stop link, and carries `In-Reply-To` and `References` naming the original, so the mailbox and the sender both thread it. Nothing is tracked.
- Spam, DMARC failures and viruses never forward. The address's webhook and `GET /v1/addresses/:id/messages` still get spam and DMARC failures, flagged.
- Forwarding stops when the address expires or is revoked, forwards already queued included. A message past `message_cap` or the daily limit isn't admitted, so it isn't forwarded either; one admitted message forwards to every confirmed target.
- A forward is a message: listed by `GET /v1/emails` with the tag `forward`, logged against the address's key, and on that key's webhooks. `counts.forwarded` on the address and `forwarded_count` on the target count them.
- A forward that hard-bounces or draws a complaint disables its target, as does the mailbox using the stop link or one-click unsubscribe. `disabled_reason` is `bounced`, `complained` or `stopped`. Remove the target and add it again to ask the mailbox again. A forward the send path refuses, such as a suppressed mailbox, shows on the target's `last_failure`.
- No reply-through: Pouch doesn't relay a reply written in the mailbox back out from the address. That would make the address a relay for mail written elsewhere.

## Watching a message: webhooks vs. the stream

Webhooks are how a system finds out something happened. They're durable — at-least-once, retried on a backoff schedule, surviving the caller being down — and that's the shape anything that *acts* on an event needs: a fulfillment system marking an order shipped, a CRM logging a bounce.

The stream is how a person watches. `GET /v1/emails/:id/events` and `GET /v1/events` are Server-Sent Events, key-authenticated like everything else on `/v1`:

- `GET /v1/emails/:id/events` — one message's transitions, from where it is now until it reaches a terminal state, then the server closes the connection. Replays the message's existing events on connect: the common case is send-then-watch, and a stream that shows nothing because everything already happened is a bad first experience. Send a `Last-Event-ID` header, the last event id received, to resume after a reconnect and replay only what's new since it.
- `GET /v1/events` — every transition the key can see, across every message, filtered by `type` when given. Held open indefinitely; the client closes it, not the server. A fresh connect with no `Last-Event-ID` starts from now rather than replaying the organization's history — that replay is bounded and useful for one message, but unbounded for everything a key can see. `Last-Event-ID` still catches a reconnect up on what it missed, capped at 500 events.

**One frame shape, matching what a webhook posts.** Each frame's `data` is `{ id, type, created_at, data }` — the same envelope `lib/webhooks/dispatch.ts` builds, and `data.data` is the message shape `GET /v1/emails/:id` returns. A caller that already parses a webhook body parses a frame with no second parser. `type` covers the full lifecycle as `email.<status>` — `email.queued`, `email.sent`, `email.delivered`, `email.deferred`, `email.bounced`, `email.complained`, `email.failed` — a superset of the three webhooks send today, since the stream shows a message moving, not only the events a receiver acts on.

**Domain scoping holds exactly as it does everywhere else.** `GET /v1/events` draws from every message the key's organization has moved, filtered to the key's `domain_ids` the same way `GET /v1/emails` is — a key scoped to one domain never receives a frame for another.

**Concurrent streams are capped separately from the request rate limit.** An idle, held-open connection isn't a request in the sense the per-minute limit below counts — it sits doing nothing most of its life. Each key may hold 10 concurrent streams open, across both routes combined (`MAX_CONCURRENT_STREAMS_PER_KEY`); past that, a connection attempt returns `429 stream_limit_exceeded`. Ten covers the legitimate case — a person watching a handful of sends from a terminal, a CI job tailing a batch of test messages — without letting one caller pin every worker on connections that never end on their own.

**Heartbeats.** A comment frame every 25 seconds keeps an idle proxy from deciding the connection is dead and closing it out from under the caller.

**Not a delivery guarantee.** A dropped connection loses nothing recorded — reconnect with `Last-Event-ID` and the gap replays — but a caller that needs to *know*, reliably, takes the webhook. The stream is for watching, not for durability.

## Rate limits

Per key, 3000 requests per minute by default: a key created without `rate_limit` takes the install's `key_rate_limit_default`, and changing that never rewrites an existing key. The limit paces ingress; it isn't what protects the sending provider. That's the provider's concurrency, plus a `429` from the provider backing the whole provider off. Accepting a message is cheap, so the ceiling is set to catch a runaway caller rather than to ration a legitimate one.

Headers on every response once a key has authenticated: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. An `invalid_key` response carries none of them — there's no key to report a limit for. Exceeding returns `429` with `Retry-After`. The limit is enforced on an approximate sliding window, not an exact one: a burst aligned to a window boundary can transiently admit up to 2x the limit before the rate settles back down. `Retry-After` is conservative and, if followed, never leads a caller into that gap. A key with no allowance (`0`) is blocked outright; its `Retry-After` is a long fixed backoff, not a countdown to recovery.

Failed authentications are limited separately, per calling address, so an unknown key can't run the key lookup without bound. Spending that allowance returns `429` for a minute — including for a valid key from the same address, since the only way to know a key is valid is the lookup being rationed. A request that authenticates never counts against it.

## Features

An admin can turn off bulk, lists, inbound, addresses, observations, DMARC reports and MCP for the whole install. Domains, messages, keys, webhooks and suppressions have no switch. A route that belongs to a feature that's off returns `403 feature_disabled` with `detail.feature`, after the key authenticates:

| Feature | Routes |
|---|---|
| `bulk` | `/v1/batches` |
| `lists` | `/v1/lists`, except `POST /v1/lists/:id/unsubscribe`, which always works |
| `inbound` | `/v1/inbound`, `/v1/domains/:id/inbound` |
| `addresses` | `/v1/addresses` |
| `mcp` | `/mcp` and every tool on it |

Lists need bulk and addresses need inbound, so turning off the first turns off the second. An MCP tool for a feature that's off returns the same error inside its result. The hosted unsubscribe and confirm pages, `POST /v1/unsubscribe` and `POST /v1/confirm` never check a feature.

## Test mode

A test-mode key accepts every valid request and delivers nothing. Messages route to a mock provider that records them and emits `delivered` a few seconds later, or `bounced` when the recipient's local part is `bounce`. Test messages appear in the dashboard, marked.

A test key reads only test mail: `GET /v1/emails`, `GET /v1/emails/:id` and both event streams leave live messages out, and a live message's id reads as `404`. `/v1/inbound` and `/v1/exports` hold only live data and return `403 key_not_scoped` to a test key.

## Documentation

The reference at pouch.email/docs/reference and every install's `/openapi.json` are generated from the zod schemas that validate requests. A field without a `.describe()` fails the docs build.
