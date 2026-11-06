# Migrating from Mailpace (direct)

Mailpace is one of Pouch's two backing providers. Self-hosted, this keeps your Mailpace organization and reputation, and the API your code calls changes from Mailpace's to Pouch's. On the hosted version the domain moves to the service's SES account.

Mailpace's docs: [mailpace.com/docs](https://mailpace.com/docs) (API reference and guides). Confirm current paths there — some of Mailpace's own pages weren't reachable while writing this guide; the request shape below is taken from Pouch's own Mailpace integration (`lib/providers/adapters/mailpace.ts`), which calls it directly.

## Sending: before and after

**Mailpace (REST)**

```bash
curl https://app.mailpace.com/api/v1/send \
  -H "MailPace-Server-Token: $MAILPACE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"onboarding@example.com","to":"ada@example.com","subject":"Welcome","htmlbody":"<p>Thanks for signing up.</p>"}'
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

| Mailpace | Pouch | Notes |
|---|---|---|
| `from`, `to`, `cc`, `bcc` | `from`, `to`, `cc`, `bcc` | Mailpace takes comma-joined strings; Pouch takes a string or array. |
| `replyto` | `reply_to` | |
| `subject`, `htmlbody`, `textbody` | `subject`, `html`, `text` | |
| `tags` | `tags` | Both flat string arrays. |
| `attachments` | `attachments` | Both `{ name/filename, content, content_type }`, base64. |
| *(none — Mailpace drops custom headers in transit)* | `headers` | Pouch accepts `headers` on every domain, but a domain backed by Mailpace still can't carry them — the provider drops them, so Pouch never sends what it can't deliver. This also means Mailpace-backed domains can't use `List-Unsubscribe` past the bulk fan-out threshold; see "Bulk" below. |
| — | `layout` | No Mailpace equivalent: wraps `html` in the domain's logo/accent/footer frame. |
| — | `subscribe` | No Mailpace equivalent: adds `to` recipients to a list at send time. |
| *(Mailpace has no bulk endpoint)* | `POST /v1/batches` | Also unavailable on a Mailpace-backed domain: Mailpace's own terms are transactional-only, and Pouch enforces `bulk_allowed: false` for domains whose provider can't do bulk (`422 bulk_not_allowed`). Move the domain to SES for bulk. |

## Domains and DNS

An admin assigns your organization a provider, and you add the domain and publish its records:

1. Add the domain: **Domains → Add domain**, or `POST /v1/domains` with `name`. It binds to your organization's assigned provider. With none assigned, it returns `422 provider_unassigned` until an admin assigns one.
2. Publish the DNS records it lists. The domain verifies on its own once they resolve.

`GET /v1/providers` lists the assigned provider with `assigned: true`.

**Self-hosting on your own Mailpace account:** as admin, add the provider in Admin settings → Providers for your organization, with its server token and its organization token, which adding a domain needs. A Mailpace account serves one organization. Mailpace can't register webhooks or remove a domain through its API: the domain's `setup` lists the webhook as a step to finish in Mailpace's dashboard, and `DELETE /v1/domains/:id` leaves the domain at Mailpace. **Unconfirmed:** whether Mailpace accepts a create for a domain it already has.

**On the hosted version** the domain moves from Mailpace to the service's SES account, so its records are new. Remove Mailpace's once nothing sends through it, and import Mailpace's block list, since Mailpace no longer sees these sends.

## Webhooks

Because Mailpace can't register webhooks through its API, this is a one-time manual step in Mailpace's dashboard regardless of whether Pouch or your own code is consuming events — point it at Pouch's webhook receiver rather than your app's. Then register the outbound webhook on the Pouch key (dashboard, key detail page) for your app to consume:

| Mailpace event | Pouch event |
|---|---|
| `email.delivered` | `email.delivered` |
| `email.bounced` | `email.bounced` |
| `email.deferred` | reflected as `status: "deferred"`, not a separate webhook |
| `email.spam` | `email.complained` |
| `email.queued` | reflected as `status: "queued"` on accept, not a separate webhook |

Full Pouch event catalog and payload shape: `docs/api/conventions.md`, "Outbound webhooks".

## Suppressions

Export Mailpace's block list from its dashboard (check `mailpace.com/docs` for the current export path — unconfirmed live while writing this).

Import them with `POST /v1/suppressions` (a key with no domain scope, at most 5,000 rows per call), or upload the CSV from the dashboard's suppressions screen with **Import**. An address that's already suppressed keeps its row, and each invalid row is reported without stopping the rest. See `docs/api/conventions.md`, "Suppressions".

Self-hosting on the same Mailpace account, importing is optional: an address Mailpace already blocks bounces through Pouch too, and Pouch suppresses it then. Import the list to stop those sends before they reach Mailpace.

Export Pouch's own list from the suppressions screen with **Export**, or page through it with `GET /v1/suppressions`.

## SMTP

Mailpace has its own SMTP relay; Pouch's ingress is the drop-in replacement for anything that only speaks SMTP: STARTTLS on port 587, `AUTH PLAIN` with the key id (`key_…`) as username and the key as password. Note Pouch's 50-recipient cap here matches Mailpace's own limit, so nothing changes for a Mailpace-backed domain specifically. Reply codes and detail: the API reference's SMTP section.

## Cutover checklist

1. Confirm your organization has an assigned provider. Self-hosting: add your Mailpace account with its server and organization tokens as admin.
2. Add the domain in Pouch, publish the records it lists and wait for `verified`.
3. Point Mailpace's dashboard webhook at Pouch's receiver, and register the Pouch webhook for your app. Hosted: only register the Pouch webhook.
4. Swap the direct Mailpace call for `pouch.emails.send(...)`, feature-flagged or on one low-traffic path first.
5. Send a real message and confirm it reaches `delivered` in Pouch's dashboard.
6. Leave the Mailpace account and DNS as they are — nothing to remove, since Pouch never took ownership of them. Hosted: remove Mailpace's records and revoke its token once nothing sends through it.
