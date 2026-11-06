# Migrating from Resend

Pouch's send API is shaped like Resend's on purpose (`docs/product/brief.md`), so this is the smallest field mapping of the seven. The gap is what sits around sending: Resend backs its own domains, and Pouch doesn't — your domain binds to the SES or Mailpace account an admin assigned to your organization (see the [index](./index.md)).

Resend's docs: [api-reference/emails/send-email](https://resend.com/docs/api-reference/emails/send-email), [webhooks/event-types](https://resend.com/docs/dashboard/webhooks/event-types), [api-reference/suppressions](https://resend.com/docs/api-reference/suppressions/list-suppressions).

## Sending: before and after

**Resend (Node SDK)**

```ts
import { Resend } from "resend";
const resend = new Resend("re_xxxxxxxxx");

await resend.emails.send({
  from: "Acme <onboarding@example.com>",
  to: ["ada@example.com"],
  subject: "Welcome",
  html: "<p>Thanks for signing up.</p>",
});
```

**Pouch (SDK)**

```ts
import { PouchClient } from "./pouch";
const pouch = new PouchClient({ apiKey: process.env.POUCH_API_KEY!, baseUrl: process.env.POUCH_URL! });

await pouch.emails.send({
  from: "Acme <onboarding@example.com>",
  to: "ada@example.com",
  subject: "Welcome",
  html: "<p>Thanks for signing up.</p>",
});
```

**Pouch (REST)**

```bash
curl $POUCH_URL/v1/emails \
  -H "Authorization: Bearer $POUCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"from":"Acme <onboarding@example.com>","to":"ada@example.com","subject":"Welcome","html":"<p>Thanks for signing up.</p>"}'
```

## Field mapping

| Resend | Pouch | Notes |
|---|---|---|
| `from` | `from` | Same shape: `Name <address>` or a bare address. |
| `to`, `cc`, `bcc` | `to`, `cc`, `bcc` | String or array on both. |
| `reply_to` | `reply_to` | |
| `subject`, `html`, `text` | `subject`, `html`, `text` | At least one of `html`/`text` required on both. |
| `headers` | `headers` | Pouch rejects reserved headers with `422 reserved_header`. |
| `tags` | `tags` | Resend's are key/value pairs; Pouch's are a flat string array, filterable in the dashboard. |
| `attachments` | `attachments` | Both base64. Pouch's size limit comes from the domain's provider (25MB on Mailpace, higher on SES) rather than a fixed platform ceiling. |
| — | `layout` | No Resend equivalent: wraps `html` in the domain's logo/accent/footer frame. Off by default. |
| — | `subscribe` | No Resend equivalent: adds `to` recipients to a list at send time. |
| `scheduled_at` | *no equivalent* | Pouch sends immediately; queue scheduled mail on your side. |
| Resend's templates (React Email, etc.) | *no equivalent* | Pouch takes rendered HTML/text only. Render before you call `POST /v1/emails`. |
| Open/click tracking | *no equivalent* | Pouch doesn't track opens or clicks. |
| Resend contacts/audiences/broadcasts | Pouch lists + `POST /v1/batches` | Narrower: a list is addresses with subscription state, no segments or audience UI. See `docs/api/conventions.md`, "Bulk". |

## Domains and DNS

Resend hosts your domain's sending setup itself. Pouch asks your organization's assigned provider for the records instead:

1. Add the domain: **Domains → Add domain**, or `POST /v1/domains` with `name`. It binds to your organization's assigned provider. With none assigned, it returns `422 provider_unassigned` until an admin assigns one.
2. Publish the DNS records it lists: DKIM, plus whatever else the provider needs. The domain verifies on its own once they resolve.
3. Remove Resend's DKIM and verification records once nothing sends through Resend. SPF and DMARC generally stay, with the new provider's `include:` added if its records ask for one.

`GET /v1/providers` lists the assigned provider with `assigned: true`. Self-hosting, you're the admin: add an SES or Mailpace account and assign it to your organization first (`docs/engineering.md`, "Providers").

## Webhooks

Register a webhook on the Pouch key that will send this traffic (dashboard, key detail page) — there's no webhook management API. Map Resend's events to Pouch's:

| Resend event | Pouch event |
|---|---|
| `email.sent` | `email.sent` (only on the SSE stream, not a webhook — see below) |
| `email.delivered` | `email.delivered` |
| `email.bounced` | `email.bounced` |
| `email.complained` | `email.complained` |
| `email.delivery_delayed` | *no webhook* — reflected in the message's `status: "deferred"`, readable via `GET /v1/emails/:id` or the SSE stream |
| `email.opened`, `email.clicked` | *no equivalent* — Pouch doesn't track opens or clicks |
| `email.scheduled` | *no equivalent* — no scheduled sends |
| `suppression.added`, `suppression.removed` | *no webhook* — suppressions aren't sent as events today; poll or re-export |
| `domain.*`, `contact.*` | *no equivalent* |

Pouch's own event catalog is wider than what's in a webhook: `email.unsubscribed`, `list.subscribed`, `domain.reputation_changed` and `organization.reputation_changed` are Pouch concepts with no Resend counterpart. Full list and payload shape: `docs/api/conventions.md`, "Outbound webhooks".

## Suppressions

Export Resend's: `GET /suppressions` (paginate with `limit`/`after`), each row an `email`, `origin` (`bounce`, `complaint` or `manual`) and `created_at`.

Import them with `POST /v1/suppressions` (a key with no domain scope, at most 5,000 rows per call), or upload the CSV from the dashboard's suppressions screen with **Import**. An address that's already suppressed keeps its row, and each invalid row is reported without stopping the rest. See `docs/api/conventions.md`, "Suppressions".

A CSV with Resend's `email` and `origin` columns imports as is, with `bounce` mapped to `hard_bounce`. For the API, map each page:

```bash
jq '{source: "resend", suppressions: [.data[] | {address: .email,
  reason: ({bounce: "hard_bounce", complaint: "complaint"}[.origin] // "manual")}]}' page.json |
curl $POUCH_URL/v1/suppressions \
  -H "Authorization: Bearer $POUCH_API_KEY" -H "Content-Type: application/json" -d @-
```

Export Pouch's own list from the suppressions screen with **Export**, or page through it with `GET /v1/suppressions`.

## SMTP

For anything that only speaks SMTP (WordPress, a monitoring tool), Pouch has its own ingress in place of Resend's: STARTTLS on port 587, `AUTH PLAIN` with the key id (`key_…`) as username and the key as password. Same send path, same suppression checks, as the HTTP API. Reply codes and full detail: the API reference's SMTP section.

## Cutover checklist

1. Confirm your organization has an assigned provider (self-hosting: add and assign one as admin), then add and verify the domain.
2. Swap `resend.emails.send(...)` for `pouch.emails.send(...)` (or the REST call) behind a flag, or on a low-traffic domain first.
3. Register the Pouch webhook endpoint and re-point anything that consumed Resend's webhooks at the new event names.
4. Import the old provider's suppressions into Pouch before cutover, so a bounce history doesn't repeat.
5. Watch the domain's status in Pouch (`GET /v1/domains/:id`, or the dashboard) until `verified`, then send a real message and confirm it reaches `delivered`.
6. Remove the Resend SDK, API key and DNS records once nothing sends through Resend.
