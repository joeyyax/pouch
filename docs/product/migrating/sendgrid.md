# Migrating from SendGrid

SendGrid isn't one of Pouch's backing providers, so this migration moves your domain's sending to the SES or Mailpace account assigned to your Pouch organization (see the [index](./index.md)) — the API call changes at the same time.

SendGrid's docs: [mail-send](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send), [event webhook](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event), [bounces API](https://www.twilio.com/docs/sendgrid/api-reference/bounces-api/retrieve-all-bounces).

## Sending: before and after

**SendGrid (Node SDK)**

```ts
import sgMail from "@sendgrid/mail";
sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

await sgMail.send({
  from: "onboarding@example.com",
  to: "ada@example.com",
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

| SendGrid | Pouch | Notes |
|---|---|---|
| `personalizations[].to`, `.cc`, `.bcc` | `to`, `cc`, `bcc` | Pouch has no personalizations array — one request is one message to its recipients, not a batch of per-recipient variants. For per-recipient substitution, use `POST /v1/batches`. |
| `from` | `from` | |
| `reply_to` / `reply_to_list` | `reply_to` | |
| `subject` | `subject` | |
| `content` (array of MIME parts) | `html`, `text` | Pouch takes the two parts directly rather than a typed content array. |
| `headers` | `headers` | Pouch rejects reserved headers with `422 reserved_header`. |
| `categories` | `tags` | Both flat string arrays; SendGrid caps at 10 per message. |
| `attachments` | `attachments` | Both base64. |
| `template_id`, dynamic template data | *no equivalent* | Pouch has no template store. Render before sending. |
| `send_at` | *no equivalent* | Pouch sends immediately. |
| `tracking_settings` (open/click/subscription tracking) | *no equivalent* | Pouch doesn't track opens or clicks; unsubscribe handling is built into bulk mode instead, not a per-message setting. |
| — | `layout` | No SendGrid equivalent: wraps `html` in the domain's logo/accent/footer frame. |
| — | `subscribe` | No SendGrid equivalent: adds `to` recipients to a list at send time. |
| SendGrid Marketing Campaigns, contacts, segments | Pouch lists + `POST /v1/batches` | Much narrower — see `docs/api/conventions.md`, "Bulk". |

## Domains and DNS

SendGrid authenticates a domain against its own shared infrastructure; Pouch authenticates against your organization's assigned provider:

1. Add the domain: **Domains → Add domain**, or `POST /v1/domains` with `name`. It binds to your organization's assigned provider. With none assigned, it returns `422 provider_unassigned` until an admin assigns one.
2. Publish the DNS records it lists. The domain verifies on its own once they resolve.
3. Remove SendGrid's CNAME records (its domain authentication and link branding) once cutover is complete. SPF needs SendGrid's `include:` dropped and the new provider's added, since a name can carry only one SPF record (`docs/api/conventions.md`, "Moving a domain to another provider").

`GET /v1/providers` lists the assigned provider with `assigned: true`. Self-hosting, you're the admin: add an SES or Mailpace account and assign it to your organization first (`docs/engineering.md`, "Providers").

## Webhooks

Register a webhook on the Pouch key (dashboard, key detail page) — there's no webhook management API. Map SendGrid's event webhook types to Pouch's:

| SendGrid event | Pouch event |
|---|---|
| `delivered` | `email.delivered` |
| `bounce` | `email.bounced` |
| `dropped` | *no direct equivalent* — closest is `email.failed`, readable via `GET /v1/emails/:id` or the SSE stream, not a webhook |
| `deferred` | reflected as `status: "deferred"`, not a separate webhook |
| `spamreport` | `email.complained` |
| `unsubscribe`, `group_unsubscribe`, `group_resubscribe` | `email.unsubscribed` — Pouch has no group/topic concept, only per-list and per-domain unsubscribe |
| `processed` | *no equivalent* — closest is `status: "queued"` on accept |
| `open`, `click` | *no equivalent* — Pouch doesn't track opens or clicks |
| `provider_status_change` | *no equivalent* |

Full Pouch event catalog and payload shape: `docs/api/conventions.md`, "Outbound webhooks".

## Suppressions

Export SendGrid's suppression lists — bounces (`GET /v3/suppression/bounces`), plus the equivalent endpoints for blocks, invalid emails and spam reports (check `twilio.com/docs/sendgrid` for their current paths, since SendGrid tracks these as separate lists rather than one).

Import them with `POST /v1/suppressions` (a key with no domain scope, at most 5,000 rows per call), or upload the CSV from the dashboard's suppressions screen with **Import**. An address that's already suppressed keeps its row, and each invalid row is reported without stopping the rest. See `docs/api/conventions.md`, "Suppressions".

Import each list with its own reason: bounces and invalid emails as `hard_bounce`, spam reports as `complaint`. A CSV with an `email` column imports directly, and a `reason` column holding SendGrid's bounce text is kept as the detail:

```bash
curl "$POUCH_URL/v1/suppressions?reason=hard_bounce&source=sendgrid" \
  -H "Authorization: Bearer $POUCH_API_KEY" -H "Content-Type: text/csv" --data-binary @bounces.csv
```

Blocks are often temporary, so import them only if you don't want to retry those addresses.

Export Pouch's own list from the suppressions screen with **Export**, or page through it with `GET /v1/suppressions`.

## SMTP

For software that only speaks SMTP, swap SendGrid's `smtp.sendgrid.net` for Pouch's ingress: STARTTLS on port 587, `AUTH PLAIN` with the key id (`key_…`) as username and the key as password. Reply codes and detail: the SMTP guide at pouch.email/docs/smtp.

## Cutover checklist

1. Confirm your organization has an assigned provider (self-hosting: add and assign one as admin), then add and verify the domain.
2. Swap `sgMail.send(...)` for `pouch.emails.send(...)`, feature-flagged or on one low-traffic path first.
3. Register the Pouch webhook and re-point anything that consumed SendGrid's event webhook.
4. Import SendGrid's bounces and spam reports into Pouch before cutover.
5. Send a real message and confirm it reaches `delivered` in Pouch's dashboard.
6. Remove SendGrid's DNS records and revoke its API key once nothing sends through it.
