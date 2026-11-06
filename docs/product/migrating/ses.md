# Migrating from Amazon SES (direct)

SES is one of Pouch's two backing providers. Self-hosted, this migration can keep your SES account and region, and the API your code calls changes from the AWS SDK or raw SMTP to Pouch's. On the hosted version the domain moves to the service's SES account.

AWS's docs: [send-email-api](https://docs.aws.amazon.com/ses/latest/dg/send-email-api.html), [send-email-smtp](https://docs.aws.amazon.com/ses/latest/dg/send-email-smtp.html), [notification-contents](https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html), [account-level suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html).

## Sending: before and after

**SES (AWS SDK v3, Node)**

```ts
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
const ses = new SESv2Client({ region: "us-east-1" });

await ses.send(new SendEmailCommand({
  FromEmailAddress: "Acme <onboarding@example.com>",
  Destination: { ToAddresses: ["ada@example.com"] },
  Content: {
    Simple: {
      Subject: { Data: "Welcome" },
      Body: { Html: { Data: "<p>Thanks for signing up.</p>" } },
    },
  },
}));
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

| SES (SendEmail / SESv2) | Pouch | Notes |
|---|---|---|
| `FromEmailAddress` | `from` | |
| `Destination.ToAddresses` | `to` | |
| `Destination.CcAddresses`, `.BccAddresses` | `cc`, `bcc` | |
| `ReplyToAddresses` | `reply_to` | |
| `Content.Simple.Subject.Data` | `subject` | |
| `Content.Simple.Body.Html.Data`, `.Text.Data` | `html`, `text` | |
| `Content.Simple.Headers` | `headers` | Pouch rejects reserved headers with `422 reserved_header`. |
| `EmailTags` | `tags` | SES tags are key/value; Pouch's are a flat string array. |
| `Content.Raw` (raw MIME, for attachments) | `attachments` | Pouch takes `{ filename, content, content_type }` and builds the MIME itself — no raw message to assemble. |
| `ConfigurationSetName` | *implicit* | Pouch's provider plumbing configures the equivalent event destination for you at setup. |
| — | `layout` | No SES equivalent: wraps `html` in the domain's logo/accent/footer frame. |
| — | `subscribe` | No SES equivalent: adds `to` recipients to a list at send time. |
| SES's contact lists / list management | Pouch lists + `POST /v1/batches` | Narrower feature set — see `docs/api/conventions.md`, "Bulk". |
| — | *no equivalent* | Scheduled sends, templates, open/click tracking — SES doesn't have most of these either; where it does (contact list preferences), Pouch doesn't match it feature for feature. |

## Domains and DNS

An admin assigns your organization a provider, and you add the domain and publish its records:

1. Add the domain: **Domains → Add domain**, or `POST /v1/domains` with `name`. It binds to your organization's assigned provider. With none assigned, it returns `422 provider_unassigned` until an admin assigns one.
2. Publish the DKIM CNAMEs it lists, plus the optional MAIL FROM MX and TXT. The domain verifies on its own once they resolve.

`GET /v1/providers` lists the assigned provider with `assigned: true`.

**Self-hosting on your own SES account:** as admin, add the provider in Admin settings → Providers with IAM credentials (`docs/engineering.md`, "IAM policies") and assign it to your organization. Your organization gets its own isolated space on it.

SES already has your domain's identity, and Pouch refuses an identity it didn't tag, so adding the domain the ordinary way returns `domain_unavailable`. Adopt it instead: **Admin settings → Providers → the provider → Adopt domain** on the organization's row, or `POST /v1/admin/domains` with `organization_id` and `name`. Pouch tags the existing identity as your organization's and keeps its DKIM, so your published records stay valid and sending never stops. It needs an admin key (`docs/api/admin.md`). An identity already tagged for another organization stays refused.

**On the hosted version** the domain gets a new identity on the service's provider. Publish its DKIM records alongside yours.

## Webhooks

SES has no key-scoped webhook concept of its own — it posts bounce, complaint and delivery notifications to an SNS topic (or a configuration set event destination), and you subscribe something to that topic yourself. Pouch replaces that plumbing: register a webhook on the Pouch key (dashboard, key detail page) and Pouch's worker reads the same underlying SES/SNS events on your behalf.

| SES notification (`notificationType` / `eventType`) | Pouch event |
|---|---|
| `Delivery` | `email.delivered` |
| `Bounce` (`Permanent`) | `email.bounced` |
| `Bounce` (`Transient`) | reflected as `status: "deferred"`, not a separate webhook |
| `Complaint` | `email.complained` |
| `Send`, `Reject`, `Open`, `Click`, `RenderingFailure`, `DeliveryDelay`, `Subscription` | *no Pouch equivalent* — Pouch doesn't track opens or clicks, and doesn't expose SES's other configuration-set events as webhooks |

Full Pouch event catalog and payload shape: `docs/api/conventions.md`, "Outbound webhooks".

## Suppressions

Export SES's account-level suppression list: `ListSuppressedDestinations` (`aws sesv2 list-suppressed-destinations --reasons BOUNCE COMPLAINT`), or a tenant-level list if you use SES tenants.

Import them with `POST /v1/suppressions` (a key with no domain scope, at most 5,000 rows per call), or upload the CSV from the dashboard's suppressions screen with **Import**. An address that's already suppressed keeps its row, and each invalid row is reported without stopping the rest. See `docs/api/conventions.md`, "Suppressions".

```bash
aws sesv2 list-suppressed-destinations --reasons BOUNCE COMPLAINT --output json |
jq '{source: "ses", suppressions: [.SuppressedDestinationSummaries[] | {address: .EmailAddress,
  reason: (if .Reason == "COMPLAINT" then "complaint" else "hard_bounce" end)}]}' |
curl $POUCH_URL/v1/suppressions \
  -H "Authorization: Bearer $POUCH_API_KEY" -H "Content-Type: application/json" -d @-
```

The CLI pages on its own; split the output into 5,000-row calls for a larger list. Import it on either path: your organization has its own suppression list at SES, and SES doesn't check the account-level list for those sends.

Export Pouch's own list from the suppressions screen with **Export**, or page through it with `GET /v1/suppressions`.

## SMTP

For anything that only speaks SMTP, swap SES's SMTP endpoint and per-region credentials for Pouch's ingress: STARTTLS on port 587, `AUTH PLAIN` with the key id (`key_…`) as username and the key as password. One endpoint regardless of which region your SES account lives in. Reply codes and detail: the API reference's SMTP section.

## Cutover checklist

1. Confirm your organization has an assigned provider. Self-hosting: add your SES account and assign it as admin.
2. Add the domain in Pouch, publish the records it lists and wait for `verified`.
3. Swap the AWS SDK call (or SMTP client) for `pouch.emails.send(...)`, feature-flagged or on one low-traffic path first.
4. Point your SNS subscription's consumer, or whatever read bounce/complaint notifications before, at the Pouch webhook instead.
5. Send a real message and confirm it reaches `delivered` in Pouch's dashboard.
6. Self-hosting, leave the SES account as it is. Hosted, remove your old DKIM records once nothing sends through your own provider.
