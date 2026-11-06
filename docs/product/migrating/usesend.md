# Migrating from useSend

useSend is, like Pouch, a small self-hostable transactional layer over a real provider — the shift here is from useSend's own domain and contact management to Pouch's, backed by the SES or Mailpace account assigned to your organization.

useSend's docs: [get-started/nodejs](https://docs.usesend.com/get-started/nodejs), domains (`GET/POST/PUT /v1/domains`), [webhooks overview](https://docs.usesend.com/llms.txt). **Unconfirmed:** useSend's exact webhook event names and its DNS record requirements weren't reachable in current docs at the time of writing — confirm both against `docs.usesend.com` before cutover.

## Sending: before and after

**useSend (Node SDK)**

```ts
import { UseSend } from "usesend-js";
const usesend = new UseSend("us_xxxxxxxxx");

await usesend.emails.send({
  from: "onboarding@example.com",
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

| useSend | Pouch | Notes |
|---|---|---|
| `from`, `to`, `cc`, `bcc` | `from`, `to`, `cc`, `bcc` | Same shapes. |
| `replyTo` | `reply_to` | |
| `subject`, `html`, `text` | `subject`, `html`, `text` | |
| `headers` | `headers` | Pouch rejects reserved headers with `422 reserved_header`. |
| `attachments` | `attachments` | Both base64-encoded, `{ filename, content, ... }` shaped. |
| `templateId`, `variables` | *no equivalent* | Pouch has no template store. Render the HTML yourself before sending. |
| `scheduledAt` | *no equivalent* | Pouch sends immediately. |
| `inReplyToId` | *no equivalent for outbound threading* | Pouch's threading is on inbound only: `in_reply_to` matched against a sent message's `provider_message_id` — see `docs/api/conventions.md`, "Inbound". |
| — | `layout` | No useSend equivalent: wraps `html` in the domain's logo/accent/footer frame. |
| — | `subscribe` | No useSend equivalent: adds `to` recipients to a list at send time. |
| useSend contacts, contact books, double opt-in | Pouch lists, `POST /v1/batches`, double opt-in | Similar shape — both default to double opt-in — but Pouch's lists are per-domain, not a separate contact book concept. |

## Domains and DNS

useSend verifies domains against its own backing provider (SES, in useSend's default setup); Pouch does the same against your organization's assigned provider:

1. Add the domain: **Domains → Add domain**, or `POST /v1/domains` with `name`. It binds to your organization's assigned provider. With none assigned, it returns `422 provider_unassigned` until an admin assigns one.
2. Publish the DNS records it lists. The domain verifies on its own once they resolve.
3. Remove useSend's records once nothing sends through it, keeping any the new records repeat.

`GET /v1/providers` lists the assigned provider with `assigned: true`. Self-hosting, you're the admin: add an SES or Mailpace account and assign it to your organization first (`docs/engineering.md`, "Providers").

If useSend sent through the same SES account, SES already has the identity and the add returns `domain_unavailable`. An admin adopts it instead, which keeps its DKIM and its published records (see the [SES guide](./ses.md#domains-and-dns)).

## Webhooks

Register a webhook on the Pouch key (dashboard, key detail page). useSend's exact event names are unconfirmed as of writing — check `docs.usesend.com`'s webhooks page for the current list before mapping — but by category:

| useSend event category | Pouch event |
|---|---|
| Delivered | `email.delivered` |
| Bounced | `email.bounced` |
| Complained | `email.complained` |
| Opened, clicked | *no equivalent* — Pouch doesn't track opens or clicks |
| Unsubscribed (contact-level) | `email.unsubscribed` |

Full Pouch event catalog and payload shape: `docs/api/conventions.md`, "Outbound webhooks".

## Suppressions

Export useSend's contact list, filtered to unsubscribed or bounced contacts, from its contacts API or dashboard.

Import them with `POST /v1/suppressions` (a key with no domain scope, at most 5,000 rows per call), or upload the CSV from the dashboard's suppressions screen with **Import**. An address that's already suppressed keeps its row, and each invalid row is reported without stopping the rest. See `docs/api/conventions.md`, "Suppressions".

Import bounced contacts with `reason: "hard_bounce"`. Unsubscribed contacts stop every send once they're suppressions, transactional mail included, so import them into a list instead (`POST /v1/lists/:id/members`) unless the person asked for no mail at all. A CSV with an `email` column imports directly:

```bash
curl "https://pouch.email/v1/suppressions?reason=hard_bounce&source=usesend" \
  -H "Authorization: Bearer $POUCH_API_KEY" -H "Content-Type: text/csv" --data-binary @bounced.csv
```

Export Pouch's own list from the suppressions screen with **Export**, or page through it with `GET /v1/suppressions`.

## SMTP

Both services offer an SMTP door for software that only speaks it. Pouch's: STARTTLS on port 587, `AUTH PLAIN` with the key id (`key_…`) as username and the key as password, same send path and suppression checks as the HTTP API. Reply codes and detail: the API reference's SMTP section.

## Cutover checklist

1. Confirm your organization has an assigned provider (self-hosting: add and assign one as admin), then add and verify the domain.
2. Swap the useSend SDK call for `pouch.emails.send(...)`, feature-flagged or on one low-traffic path first.
3. Confirm useSend's actual webhook event names against its current docs, then register and map the Pouch webhook.
4. Import the old provider's suppressions into Pouch before cutover.
5. Send a real message and confirm it reaches `delivered` in Pouch's dashboard.
6. Decommission the useSend instance or provider once nothing sends through it.
