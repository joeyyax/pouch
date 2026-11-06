# Migrating from Mailgun

Mailgun isn't one of Pouch's backing providers, so this migration moves your domain's sending to the SES or Mailpace account assigned to your Pouch organization (see the [index](./index.md)) — the API call changes at the same time.

Mailgun's docs: [sending messages](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-http), [tracking messages / webhooks](https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/). **Unconfirmed:** Mailgun's exact suppression-list endpoint paths (bounces, complaints, unsubscribes) weren't reachable in current docs at the time of writing — confirm against `documentation.mailgun.com` before cutover, and confirm the full webhook event list the same way; only `unsubscribed` was verifiable live.

## Sending: before and after

**Mailgun (mailgun.js)**

```ts
import Mailgun from "mailgun.js";
const mailgun = new Mailgun(FormData);
const client = mailgun.client({ username: "api", key: process.env.MAILGUN_API_KEY! });

await client.messages.create("example.com", {
  from: "Acme <onboarding@example.com>",
  to: "ada@example.com",
  subject: "Welcome",
  html: "<p>Thanks for signing up.</p>",
});
```

**Pouch (SDK)**

```ts
import { PouchClient } from "./pouch";
const pouch = new PouchClient({ apiKey: process.env.POUCH_API_KEY! });

await pouch.emails.send({
  from: "Acme <onboarding@example.com>",
  to: "ada@example.com",
  subject: "Welcome",
  html: "<p>Thanks for signing up.</p>",
});
```

**Pouch (REST)**

```bash
curl https://pouch.email/v1/emails \
  -H "Authorization: Bearer $POUCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"from":"Acme <onboarding@example.com>","to":"ada@example.com","subject":"Welcome","html":"<p>Thanks for signing up.</p>"}'
```

## Field mapping

| Mailgun | Pouch | Notes |
|---|---|---|
| `from`, `to`, `cc`, `bcc` | `from`, `to`, `cc`, `bcc` | |
| `h:Reply-To` | `reply_to` | Pouch has a first-class field; Mailgun sends it as a prefixed custom header. |
| `subject`, `html`, `text` | `subject`, `html`, `text` | |
| `h:*` (custom headers) | `headers` | Pouch rejects reserved headers with `422 reserved_header`. |
| `o:tag` | `tags` | Both string arrays (Mailgun allows repeating the field; Pouch takes a JSON array). |
| `attachment` (multipart file) | `attachments` | Pouch takes base64 content in the JSON body rather than a multipart upload. |
| `o:testmode` | test-mode key (`sk_test_…`) | Pouch's test mode is a property of the key, not a per-send flag. |
| `template`, `t:variables` | *no equivalent* | Pouch has no template store. Render before sending. |
| `o:deliverytime` | *no equivalent* | Pouch sends immediately. |
| `o:tracking`, `o:tracking-clicks`, `o:tracking-opens` | *no equivalent* | Pouch doesn't track opens or clicks. |
| — | `layout` | No Mailgun equivalent: wraps `html` in the domain's logo/accent/footer frame. |
| — | `subscribe` | No Mailgun equivalent: adds `to` recipients to a list at send time. |
| Mailgun mailing lists | Pouch lists + `POST /v1/batches` | Narrower — see `docs/api/conventions.md`, "Bulk". |

## Domains and DNS

Mailgun authenticates a domain against its own infrastructure; Pouch authenticates against your organization's assigned provider:

1. Add the domain: **Domains → Add domain**, or `POST /v1/domains` with `name`. It binds to your organization's assigned provider. With none assigned, it returns `422 provider_unassigned` until an admin assigns one.
2. Publish the DNS records it lists. The domain verifies on its own once they resolve.
3. Remove Mailgun's DKIM TXT and its tracking CNAME once cutover is complete. SPF needs Mailgun's `include:` dropped and the new provider's added.

`GET /v1/providers` lists the assigned provider with `assigned: true`. Self-hosting, you're the admin: add an SES or Mailpace account and assign it to your organization first (`docs/engineering.md`, "Providers").

## Webhooks

Register a webhook on the Pouch key (dashboard, key detail page) — there's no webhook management API. Mailgun's event names are only partly confirmed live (see the note above); by category:

| Mailgun event | Pouch event |
|---|---|
| `delivered` | `email.delivered` |
| `permanent_fail` | `email.bounced` |
| `temporary_fail` | reflected as `status: "deferred"`, not a separate webhook |
| `complained` | `email.complained` |
| `unsubscribed` | `email.unsubscribed` |
| `opened`, `clicked` | *no equivalent* — Pouch doesn't track opens or clicks |
| `accepted` | *no equivalent* — closest is `status: "queued"` on accept |

Full Pouch event catalog and payload shape: `docs/api/conventions.md`, "Outbound webhooks".

## Suppressions

Export Mailgun's suppression lists — separate endpoints for bounces, complaints and unsubscribes under `/v3/{domain}/bounces`, `/complaints` and `/unsubscribes` in Mailgun's API (confirm exact paths against current docs, per the note above).

Import them with `POST /v1/suppressions` (a key with no domain scope, at most 5,000 rows per call), or upload the CSV from the dashboard's suppressions screen with **Import**. An address that's already suppressed keeps its row, and each invalid row is reported without stopping the rest. See `docs/api/conventions.md`, "Suppressions".

Import each list with its own reason: bounces as `hard_bounce`, complaints as `complaint`. A file with an `address` column and Mailgun's `error` column imports with the error kept as the detail:

```bash
curl "https://pouch.email/v1/suppressions?reason=hard_bounce&source=mailgun" \
  -H "Authorization: Bearer $POUCH_API_KEY" -H "Content-Type: text/csv" --data-binary @bounces.csv
```

Unsubscribes stop every send once they're suppressions, transactional mail included. Import them into a list instead (`POST /v1/lists/:id/members`) unless the person asked for no mail at all.

Export Pouch's own list from the suppressions screen with **Export**, or page through it with `GET /v1/suppressions`.

## SMTP

For software that only speaks SMTP, swap Mailgun's `smtp.mailgun.org` for Pouch's ingress: STARTTLS on port 587, `AUTH PLAIN` with the key id (`key_…`) as username and the key as password. Reply codes and detail: the API reference's SMTP section.

## Cutover checklist

1. Confirm your organization has an assigned provider (self-hosting: add and assign one as admin), then add and verify the domain.
2. Swap `client.messages.create(...)` for `pouch.emails.send(...)`, feature-flagged or on one low-traffic path first.
3. Confirm Mailgun's current webhook event names and suppression endpoint paths against its docs, then register and map the Pouch webhook.
4. Import the old provider's suppressions into Pouch before cutover.
5. Send a real message and confirm it reaches `delivered` in Pouch's dashboard.
6. Remove Mailgun's DNS records and revoke its API key once nothing sends through it.
