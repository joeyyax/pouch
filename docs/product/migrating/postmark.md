# Migrating from Postmark

Postmark isn't one of Pouch's backing providers, so this migration moves your domain's sending to the SES or Mailpace account assigned to your Pouch organization (see the [index](./index.md)) — the API call changes at the same time.

Postmark's docs: [email API](https://postmarkapp.com/developer/api/email-api), [webhooks overview](https://postmarkapp.com/developer/webhooks/webhooks-overview) (check current URL — moved since writing), [suppressions API](https://postmarkapp.com/developer/api/suppressions-api).

## Sending: before and after

**Postmark (Node SDK)**

```ts
import * as postmark from "postmark";
const client = new postmark.ServerClient(process.env.POSTMARK_TOKEN!);

await client.sendEmail({
  From: "onboarding@example.com",
  To: "ada@example.com",
  Subject: "Welcome",
  HtmlBody: "<p>Thanks for signing up.</p>",
  MessageStream: "outbound",
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

| Postmark | Pouch | Notes |
|---|---|---|
| `From` | `from` | |
| `To`, `Cc`, `Bcc` | `to`, `cc`, `bcc` | Postmark takes comma-separated strings; Pouch takes a string or array. |
| `ReplyTo` | `reply_to` | |
| `Subject`, `HtmlBody`, `TextBody` | `subject`, `html`, `text` | |
| `Headers` | `headers` | Pouch rejects reserved headers with `422 reserved_header`. |
| `Attachments` | `attachments` | Both base64, `{ filename, content, content_type }` shaped. |
| `Tag` | `tags` | Postmark's is a single string; Pouch's is a string array. |
| `MessageStream` | *no equivalent* | Pouch has no separate outbound/broadcast streams — one send path per domain. |
| `TemplateId`, `TemplateModel` | *no equivalent* | Pouch has no template store. Render before sending. |
| `TrackOpens`, `TrackLinks` | *no equivalent* | Pouch doesn't track opens or clicks. |
| — | `layout` | No Postmark equivalent: wraps `html` in the domain's logo/accent/footer frame. |
| — | `subscribe` | No Postmark equivalent: adds `to` recipients to a list at send time. |

## Domains and DNS

Postmark authenticates a domain against its own infrastructure ("Sender Signatures" and DKIM); Pouch authenticates against your organization's assigned provider:

1. Add the domain: **Domains → Add domain**, or `POST /v1/domains` with `name`. It binds to your organization's assigned provider. With none assigned, it returns `422 provider_unassigned` until an admin assigns one.
2. Publish the DNS records it lists. The domain verifies on its own once they resolve.
3. Remove Postmark's DKIM and Return-Path CNAMEs once cutover is complete. SPF needs Postmark's `include:` dropped and the new provider's added.

`GET /v1/providers` lists the assigned provider with `assigned: true`. Self-hosting, you're the admin: add an SES or Mailpace account and assign it to your organization first (`docs/engineering.md`, "Providers").

## Webhooks

Register a webhook on the Pouch key (dashboard, key detail page) — there's no webhook management API. Map Postmark's webhook types to Pouch's:

| Postmark webhook | Pouch event |
|---|---|
| Delivery | `email.delivered` |
| Bounce (hard) | `email.bounced` |
| Bounce (soft/transient) | reflected as `status: "deferred"`, not a separate webhook |
| SpamComplaint | `email.complained` |
| SubscriptionChange | `email.unsubscribed` |
| Open, Click | *no equivalent* — Pouch doesn't track opens or clicks |
| InboundMessage | Pouch's own inbound: `inbound.received`, domain-scoped — see `docs/api/conventions.md`, "Inbound" |

Full Pouch event catalog and payload shape: `docs/api/conventions.md`, "Outbound webhooks".

## Suppressions

Export Postmark's: `GET /message-streams/{stream_id}/suppressions/dump`, each row an `EmailAddress`, `SuppressionReason` (`HardBounce`, `SpamComplaint`, `ManualSuppression`) and `CreatedAt`.

Import them with `POST /v1/suppressions` (a key with no domain scope, at most 5,000 rows per call), or upload the CSV from the dashboard's suppressions screen with **Import**. An address that's already suppressed keeps its row, and each invalid row is reported without stopping the rest. See `docs/api/conventions.md`, "Suppressions".

The dump is JSON. Map it with `jq` and send it as is:

```bash
curl -s "https://api.postmarkapp.com/message-streams/outbound/suppressions/dump" \
  -H "X-Postmark-Server-Token: $POSTMARK_TOKEN" -H "Accept: application/json" |
jq '{source: "postmark", suppressions: [.Suppressions[] | {address: .EmailAddress,
  reason: ({HardBounce: "hard_bounce", SpamComplaint: "complaint"}[.SuppressionReason] // "manual")}]}' |
curl $POUCH_URL/v1/suppressions \
  -H "Authorization: Bearer $POUCH_API_KEY" -H "Content-Type: application/json" -d @-
```

A CSV with `EmailAddress` and `SuppressionReason` columns imports directly too: the dashboard reads those names and maps `HardBounce`, `SpamComplaint` and `ManualSuppression`.

Export Pouch's own list from the suppressions screen with **Export**, or page through it with `GET /v1/suppressions`.

## SMTP

For software that only speaks SMTP, swap Postmark's `smtp.postmarkapp.com` for Pouch's ingress: STARTTLS on port 587, `AUTH PLAIN` with the key id (`key_…`) as username and the key as password. Reply codes and detail: the SMTP guide at pouch.email/docs/smtp.

## Cutover checklist

1. Confirm your organization has an assigned provider (self-hosting: add and assign one as admin), then add and verify the domain.
2. Swap `client.sendEmail(...)` for `pouch.emails.send(...)`, feature-flagged or on one low-traffic path first.
3. Register the Pouch webhook and re-point anything that consumed Postmark's webhooks.
4. Import the old provider's suppressions into Pouch before cutover.
5. Send a real message and confirm it reaches `delivered` in Pouch's dashboard.
6. Remove Postmark's DNS records and revoke its server token once nothing sends through it.
